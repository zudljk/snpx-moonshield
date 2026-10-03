import importlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from edmc.Moonshield.moonshield_core import (
    DEFAULT_CARRIER_ID, DispatchError, Outbox, Sender, dispatch, observation,
)


def entry(kind="CarrierLocation", **changes):
    data = {"event": kind, "timestamp": "2026-09-27T20:28:10Z", "CarrierID": 3706829824,
            "CarrierType": "FleetCarrier", "StarSystem": "Hegua BP-A c12", "SystemAddress": 3376347713538}
    data.update(changes)
    return data


class Response:
    def __init__(self, code=204, headers=None):
        self.status_code, self.headers = code, headers or {}
        self.closed = False

    def close(self):
        self.closed = True


class Session:
    def __init__(self, response=None):
        self.response = response or Response()
        self.calls = []
        self.closed = False

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response

    def close(self):
        self.closed = True


class JournalTests(unittest.TestCase):
    def test_location_and_large_python_integers(self):
        payload = observation(entry(SystemAddress=18446744073709551615), DEFAULT_CARRIER_ID)
        self.assertEqual(payload["systemAddress"], "18446744073709551615")
        self.assertEqual(payload["observedAt"], "2026-09-27T20:28:10.000Z")
        self.assertEqual(set(payload), {"schemaVersion", "carrierId", "eventId", "observedAt", "source", "name", "systemAddress"})
        self.assertEqual(observation(entry(), DEFAULT_CARRIER_ID), observation(entry(), DEFAULT_CARRIER_ID))
        older = entry()
        del older["CarrierType"]
        self.assertIsNotNone(observation(older, DEFAULT_CARRIER_ID))

    def test_filters(self):
        cases = [entry(CarrierID=3713154816), entry(CarrierType="SquadronCarrier"), entry(Multicrew=True)]
        cases += [entry(kind) for kind in ("FSDJump", "Undocked", "CarrierJumpRequest", "CarrierJumpCancelled")]
        for data in cases:
            self.assertIsNone(observation(data, DEFAULT_CARRIER_ID))
        self.assertIsNone(observation(entry(), DEFAULT_CARRIER_ID, is_beta=True))
        self.assertIsNone(observation(entry(), DEFAULT_CARRIER_ID, is_live=False))

    def test_docking_and_jump_require_explicit_carrier_identity(self):
        for kind in ("Docked", "Location", "CarrierJump"):
            data = entry(kind, MarketID=3706829824, StationType="FleetCarrier", Docked=True)
            self.assertIsNotNone(observation(data, DEFAULT_CARRIER_ID))
            self.assertIsNone(observation({**data, "MarketID": 123}, DEFAULT_CARRIER_ID))
            self.assertIsNone(observation({**data, "StationType": "Coriolis"}, DEFAULT_CARRIER_ID))
        self.assertIsNone(observation(entry("Location", MarketID=3706829824, StationType="FleetCarrier", Docked=False), DEFAULT_CARRIER_ID))
        self.assertIsNone(observation(entry("CarrierJump", Docked=False, OnFoot=True), DEFAULT_CARRIER_ID))
        location = observation(entry(), DEFAULT_CARRIER_ID)
        docked = observation(entry("Docked", MarketID=3706829824, StationType="FleetCarrier"), DEFAULT_CARRIER_ID)
        self.assertEqual(location["eventId"], docked["eventId"])

    def test_malformed_observations_are_not_invented(self):
        for changes in ({"SystemAddress": None}, {"StarSystem": ""}, {"timestamp": "bad"}, {"timestamp": "2026-09-27T20:28:10"}):
            with self.assertRaises(ValueError):
                observation(entry(**changes), DEFAULT_CARRIER_ID)


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / "outbox.sqlite3"
        self.box = Outbox(self.file)
        self.payload = observation(entry(), DEFAULT_CARRIER_ID)

    def test_persistence_order_dedup_and_repository_isolation(self):
        later = observation(entry(timestamp="2026-09-27T20:29:10Z"), DEFAULT_CARRIER_ID)
        self.box.add("owner/repo", later)
        self.box.add("owner/repo", self.payload)
        restarted = Outbox(self.file)
        self.assertEqual(restarted.next("owner/repo"), self.payload)
        self.assertIsNone(restarted.next("other/repo"))
        self.assertFalse(restarted.add("owner/repo", self.payload))
        restarted.acknowledge("owner/repo", self.payload["eventId"])
        self.assertFalse(restarted.add("owner/repo", self.payload))
        self.assertEqual(restarted.next("owner/repo"), later)
        self.assertEqual(restarted.pending("owner/repo"), 1)

    def test_dispatch_contract_and_no_redirects(self):
        session = Session()
        dispatch(session, "owner/repo", "private-token", self.payload)
        url, args = session.calls[0]
        self.assertEqual(url, "https://api.github.com/repos/owner/repo/dispatches")
        self.assertEqual(args["json"], {"event_type": "moonshield-position-v1", "client_payload": self.payload})
        self.assertEqual(args["headers"]["Authorization"], "Bearer private-token")
        self.assertEqual(args["timeout"], (5, 15))
        self.assertFalse(args["allow_redirects"])
        self.assertNotIn("private-token", json.dumps(args["json"]))
        self.assertTrue(session.response.closed)
        with self.assertRaises(ValueError):
            dispatch(session, "https://attacker.example/repo", "private-token", self.payload)
        self.assertEqual(len(session.calls), 1)

    def test_failure_retains_event_then_success_acknowledges(self):
        self.box.add("owner/repo", self.payload)
        sender = Sender(self.box, Session)
        sender.configure(True, "owner/repo", "token")
        for code in (401, 403, 404, 422, 429, 500):
            with self.assertRaises(DispatchError):
                sender.deliver_one(Session(Response(code)))
            self.assertEqual(self.box.pending("owner/repo"), 1)
        self.assertTrue(sender.deliver_one(Session()))
        self.assertEqual(self.box.pending("owner/repo"), 0)
        self.assertEqual(sender.status(), ("Accepted by GitHub", self.payload["observedAt"]))
        self.assertFalse(sender.deliver_one(Session()))

    def test_pause_missing_token_and_changed_repository_do_not_send(self):
        self.box.add("owner/repo", self.payload)
        sender = Sender(self.box, Session)
        session = Session()
        for settings in ((False, "owner/repo", "token"), (True, "owner/repo", ""), (True, "other/repo", "token")):
            sender.configure(*settings)
            self.assertFalse(sender.deliver_one(session))
        self.assertEqual(session.calls, [])
        self.assertEqual(self.box.pending("owner/repo"), 1)

    def test_network_errors_hide_credentials_and_rate_limits_preserve_delay(self):
        class Broken(Session):
            def post(self, *args, **kwargs):
                raise RuntimeError("private-token")
        with self.assertRaises(DispatchError) as error:
            dispatch(Broken(), "owner/repo", "private-token", self.payload)
        self.assertNotIn("private-token", str(error.exception))
        with self.assertRaises(DispatchError) as error:
            dispatch(Session(Response(429, {"Retry-After": "600"})), "owner/repo", "token", self.payload)
        self.assertEqual(error.exception.retry_after, 600)

    def test_worker_stops_without_waiting_for_retry_timer(self):
        called = threading.Event()
        class Failure(Session):
            def post(self, *args, **kwargs):
                called.set()
                return Response(503)
        self.box.add("owner/repo", self.payload)
        session = Failure()
        sender = Sender(self.box, lambda: session)
        sender.configure(True, "owner/repo", "token")
        sender.thread.start()
        self.addCleanup(sender.stop)
        self.assertTrue(called.wait(2))
        sender.stop()
        sender.thread.join(2)
        self.assertFalse(sender.thread.is_alive())
        self.assertTrue(session.closed)
        self.assertEqual(self.box.pending("owner/repo"), 1)


class EDMCAdapterTests(unittest.TestCase):
    def test_start_callback_and_stop_with_fake_edmc(self):
        values = {"moonshield_enabled": True, "moonshield_repository": "owner/repo"}
        config = types.SimpleNamespace(
            get_bool=lambda key, default=False: values.get(key, default),
            get_str=lambda key, default="": values.get(key, default),
            shutting_down=False,
        )
        modules = {
            "config": types.SimpleNamespace(config=config, appname="EDMC"),
            "monitor": types.SimpleNamespace(monitor=types.SimpleNamespace(is_live_galaxy=lambda: True)),
            "myNotebook": types.SimpleNamespace(),
            "timeout_session": types.SimpleNamespace(new_session=Session),
            "tkinter": types.SimpleNamespace(),
        }
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, modules), patch.dict("os.environ", {"MOONSHIELD_GITHUB_TOKEN": ""}):
            sys.modules.pop("edmc.Moonshield.load", None)
            plugin = importlib.import_module("edmc.Moonshield.load")
            self.assertEqual(plugin.plugin_start3(folder), "Moonshield")
            try:
                self.assertIsNone(plugin.journal_entry("Commander", False, "", "", entry(), {}))
                self.assertEqual(plugin.outbox.pending("owner/repo"), 1)
                plugin.journal_entry("Commander", False, "", "", entry(), {})
                self.assertEqual(plugin.outbox.pending("owner/repo"), 1)
            finally:
                plugin.plugin_stop()
                sys.modules.pop("edmc.Moonshield.load", None)


if __name__ == "__main__":
    unittest.main()
