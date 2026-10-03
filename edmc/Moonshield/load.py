"""EDMC entry points. Network and retry work never touches tkinter."""
import logging
import os
from pathlib import Path
import tkinter as tk

import myNotebook as nb
import timeout_session
from config import appname, config
from monitor import monitor

from .moonshield_core import (
    VERSION, DEFAULT_CARRIER_ID, DEFAULT_REPOSITORY,
    Outbox, Sender, game_id, observation, repository_name,
)

logger = logging.getLogger(f"{appname}.{Path(__file__).parent.name}")
PREFIX = "moonshield_"
sender = None
outbox = None
settings = {}
prefs = {}
status_widget = None
after_id = None
stopped = False


def read_settings():
    return {
        "enabled": config.get_bool(PREFIX + "enabled", default=False),
        "repository": config.get_str(PREFIX + "repository", default=DEFAULT_REPOSITORY),
        "carrier_id": config.get_str(PREFIX + "carrier_id", default=DEFAULT_CARRIER_ID),
        "token": config.get_str(PREFIX + "token", default=""),
    }


def apply_settings(values):
    global settings
    repository = repository_name(values["repository"])
    carrier_id = game_id(values["carrier_id"])
    settings = {**values, "repository": repository, "carrier_id": carrier_id}
    sender.configure(settings["enabled"], repository, os.environ.get("MOONSHIELD_GITHUB_TOKEN") or settings["token"])


def plugin_start3(plugin_dir):
    global sender, outbox, stopped
    stopped = False
    outbox = Outbox(Path(plugin_dir) / "state" / "outbox.sqlite3")
    sender = Sender(outbox, timeout_session.new_session)
    try:
        apply_settings(read_settings())
    except ValueError:
        apply_settings({"enabled": False, "repository": DEFAULT_REPOSITORY,
                        "carrier_id": DEFAULT_CARRIER_ID, "token": ""})
        sender.set_message("Invalid saved settings; disabled")
    sender.thread.start()
    logger.info("Moonshield %s loaded", VERSION)
    return "Moonshield"


def plugin_app(parent):
    global status_widget
    label = tk.Label(parent, text="Moonshield:")
    status_widget = tk.Label(parent, anchor=tk.W, justify=tk.LEFT)
    refresh_status()
    return label, status_widget


def refresh_status():
    global after_id
    if stopped or config.shutting_down:
        return
    message, success = sender.status()
    try:
        pending = outbox.pending(settings["repository"])
        text = f"{message} · {pending} queued"
        if success:
            text += f"\nLast accepted observation: {success}"
    except Exception:
        text = "Local queue unavailable"
    status_widget.configure(text=text)
    after_id = status_widget.after(1000, refresh_status)


def plugin_prefs(parent, cmdr, is_beta):
    global prefs
    values = read_settings()
    frame = nb.Frame(parent)
    prefs = {key: tk.BooleanVar(frame, value=value) if key == "enabled" else tk.StringVar(frame, value=value)
             for key, value in values.items()}
    nb.Checkbutton(frame, text="Enable capture and delivery", variable=prefs["enabled"]).grid(row=0, column=0, columnspan=2, sticky=tk.W)
    for row, (key, label) in enumerate([
        ("repository", "GitHub repository (owner/name)"),
        ("carrier_id", "CarrierID / MarketID"),
        ("token", "GitHub token"),
    ], start=1):
        nb.Label(frame, text=label).grid(row=row, column=0, sticky=tk.W, padx=5, pady=3)
        nb.Entry(frame, textvariable=prefs[key], show="*" if key == "token" else "", width=42).grid(row=row, column=1, sticky=tk.EW, padx=5)
    nb.Label(frame, text="Token: selected repository, Contents: read and write.\nMOONSHIELD_GITHUB_TOKEN overrides the saved token.\nSaved tokens use EDMC settings (not encrypted).\nEnable after the receiving GitHub workflow is installed.", justify=tk.LEFT).grid(row=4, column=0, columnspan=2, sticky=tk.W, padx=5, pady=8)
    return frame


def prefs_changed(cmdr, is_beta):
    if not prefs:
        return
    values = {key: variable.get() for key, variable in prefs.items()}
    values["token"] = values["token"].strip()
    try:
        apply_settings(values)
    except ValueError as error:
        import plug
        plug.show_error("Moonshield: " + str(error))
        return
    for key, value in settings.items():
        config.set(PREFIX + key, value)


def journal_entry(cmdr, is_beta, system, station, entry, state):
    if stopped or not settings.get("enabled"):
        return None
    try:
        payload = observation(entry, settings["carrier_id"], is_beta=is_beta, is_live=monitor.is_live_galaxy())
        if payload is not None and outbox.add(settings["repository"], payload):
            sender.wake.set()
    except ValueError:
        logger.warning("Ignored malformed carrier observation")
        return "Moonshield: invalid carrier observation; not queued"
    except Exception:
        logger.error("Could not persist carrier observation")
        return "Moonshield: could not save observation to local queue"
    return None


def plugin_stop():
    global stopped
    stopped = True
    if after_id is not None and status_widget is not None:
        status_widget.after_cancel(after_id)
    if sender is not None:
        sender.stop()
