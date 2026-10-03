"""Journal filtering and durable delivery; independent of EDMC and tkinter."""
import hashlib
import json
import re
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

VERSION = "0.1.0"
EVENT_TYPE = "moonshield-position-v1"
DEFAULT_REPOSITORY = "zudljk/snpx-moonshield"
DEFAULT_CARRIER_ID = "3706829824"


def game_id(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not re.fullmatch(r"[0-9]+", str(value)):
        raise ValueError("Invalid game ID")
    number = int(value)
    if not 0 < number < 2**64:
        raise ValueError("Invalid game ID")
    return str(number)


def repository_name(value):
    value = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+", value) or value.split("/")[1] in (".", ".."):
        raise ValueError("Repository must be owner/name, not a URL")
    return value


def observation(entry, carrier_id, *, is_beta=False, is_live=True):
    """Return only positively identified carrier locations, never player jumps."""
    if is_beta or not is_live or entry.get("Multicrew"):
        return None
    kind = entry.get("event")
    if kind == "CarrierLocation":
        if entry.get("CarrierType", "FleetCarrier") != "FleetCarrier":
            return None
        identity = entry.get("CarrierID")
    elif kind in ("Docked", "Location", "CarrierJump"):
        if entry.get("StationType") != "FleetCarrier":
            return None
        if kind != "Docked" and entry.get("Docked") is not True:
            return None
        identity = entry.get("MarketID")
    else:
        return None
    if identity is None or game_id(identity) != game_id(carrier_id):
        return None
    name = entry.get("StarSystem")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Carrier observation has no system name")
    address = game_id(entry.get("SystemAddress"))
    stamp = entry.get("timestamp")
    if not isinstance(stamp, str):
        raise ValueError("Carrier observation has no timestamp")
    when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    if when.tzinfo is None:
        raise ValueError("Journal timestamp must include a timezone")
    when = when.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    # The ID describes the observation, not its delivery attempt or Journal filename.
    key = json.dumps([game_id(carrier_id), when, address], separators=(",", ":"))
    return {
        "schemaVersion": 1,
        "carrierId": game_id(carrier_id),
        "eventId": "journal:" + hashlib.sha256(key.encode("utf-8")).hexdigest(),
        "observedAt": when,
        "source": "journal",
        "name": name.strip(),
        "systemAddress": address,
    }


class Outbox:
    def __init__(self, filename):
        self.filename = str(filename)
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        with self.lock, self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS events (repository TEXT, event_id TEXT, observed_at TEXT, payload TEXT, sent INTEGER DEFAULT 0, PRIMARY KEY(repository, event_id))")

    def connect(self):
        # Explicit close as sqlite's connection context manager only commits/rolls back.
        return closing_connection(self.filename)

    def add(self, repository, payload):
        repository = repository_name(repository)
        with self.lock, self.connect() as db:
            result = db.execute("INSERT OR IGNORE INTO events(repository,event_id,observed_at,payload) VALUES(?,?,?,?)",
                                (repository, payload["eventId"], payload["observedAt"], json.dumps(payload)))
            return result.rowcount == 1

    def next(self, repository):
        with self.lock, self.connect() as db:
            row = db.execute("SELECT payload FROM events WHERE repository=? AND sent=0 ORDER BY observed_at, rowid LIMIT 1", (repository,)).fetchone()
        return json.loads(row[0]) if row else None

    def acknowledge(self, repository, event_id):
        with self.lock, self.connect() as db:
            db.execute("UPDATE events SET sent=1 WHERE repository=? AND event_id=?", (repository, event_id))

    def pending(self, repository):
        with self.lock, self.connect() as db:
            return db.execute("SELECT COUNT(*) FROM events WHERE repository=? AND sent=0", (repository,)).fetchone()[0]


class closing_connection:
    def __init__(self, filename):
        self.db = sqlite3.connect(filename, timeout=5)

    def __enter__(self):
        return self.db

    def __exit__(self, kind, value, traceback):
        try:
            if kind is None:
                self.db.commit()
            else:
                self.db.rollback()
        finally:
            self.db.close()


class DispatchError(Exception):
    def __init__(self, message, retry_after=0):
        super().__init__(message)
        self.retry_after = retry_after


def dispatch(session, repository, token, payload):
    url = "https://api.github.com/repos/" + repository_name(repository) + "/dispatches"
    try:
        response = session.post(url, json={"event_type": EVENT_TYPE, "client_payload": payload}, headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
        }, timeout=(5, 15), allow_redirects=False)
    except Exception:
        # Never display exception text from HTTP clients: it can contain credentials.
        raise DispatchError("Network error; observation remains queued") from None
    try:
        if response.status_code != 204:
            retry = response.headers.get("Retry-After", "0")
            retry = int(retry) if retry.isdigit() else 0
            raise DispatchError("GitHub HTTP %s; check repository, token and permissions" % response.status_code, retry)
    finally:
        response.close()


class Sender:
    def __init__(self, outbox, session_factory):
        self.outbox = outbox
        self.session_factory = session_factory
        self.lock = threading.Lock()
        self.settings = (False, DEFAULT_REPOSITORY, "")
        self.message = "Disabled"
        self.last_success = ""
        self.wake = threading.Event()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name="Moonshield delivery", daemon=True)

    def configure(self, enabled, repository, token):
        with self.lock:
            self.settings = (enabled, repository_name(repository), token)
            self.message = "Waiting for observations" if enabled and token else "Token missing" if enabled else "Disabled"
        self.wake.set()

    def status(self):
        with self.lock:
            return self.message, self.last_success

    def set_message(self, value):
        with self.lock:
            self.message = value

    def deliver_one(self, session):
        with self.lock:
            enabled, repository, token = self.settings
        if not enabled or not token:
            return False
        payload = self.outbox.next(repository)
        if payload is None:
            return False
        dispatch(session, repository, token, payload)
        self.outbox.acknowledge(repository, payload["eventId"])
        with self.lock:
            self.last_success = payload["observedAt"]
            self.message = "Accepted by GitHub"
        return True

    def run(self):
        session = None
        failures = 0
        try:
            while not self.stop_event.is_set():
                self.wake.clear()
                delay = 30
                try:
                    if session is None:
                        session = self.session_factory()
                    if self.deliver_one(session):
                        failures = 0
                        self.stop_event.wait(1)
                        continue
                except DispatchError as error:
                    failures += 1
                    self.set_message(str(error))
                    delay = max(min(5 * 2**min(failures - 1, 6), 300), error.retry_after)
                except Exception:
                    self.set_message("Local queue error; delivery paused until retry")
                    delay = 30
                self.wake.wait(delay)
        finally:
            if session is not None:
                session.close()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread.is_alive():
            self.thread.join(timeout=0.2)
