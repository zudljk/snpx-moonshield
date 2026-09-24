from config import appname, applongname, appcmdname, appversion, copyright, config
from monitor import monitor
from typing import Optional, Dict, Any, Tuple
import json
import logging
from threading import Thread
import os
import requests
import semantic_version


plugin_name = os.path.basename(os.path.dirname(__file__))
logger = logging.getLogger(f"FCOC-API.{plugin_name}")


if not logger.hasHandlers():
    level = logging.INFO
    logger.setLevel(level)
    logger_channel = logging.StreamHandler()
    logger_formatter = logging.Formatter(
        f"%(asctime)s - %(name)s - %(levelname)s - %(module)s:%(lineno)d:%(funcName)s: %(message)s"
    )
    logger_formatter.default_time_format = "%Y-%m-%d %H:%M:%S"
    logger_formatter.default_msec_format = "%s.%03d"
    logger_channel.setFormatter(logger_formatter)
    logger.addHandler(logger_channel)


def update_endpoints(url: str, configName: str) -> None:
    logger.info(f"Requesting API endpoints...")
    msg = requests.get(f"{url}/openapi.json/")
    if msg.status_code == 200:
        FCOC_paths = list(msg.json()["paths"].keys())
        postable_events = []
        for path in FCOC_paths:
            if path != "/":
                postable_events.append(path.replace("/", ""))
        config.set(configName, postable_events)
        logger.info(
            f"FCOC API endpoints updated successfully. Available endpoints: {postable_events}; Code: {msg.status_code}"
        )
    else:
        logger.warning(
            f"FCOC API endpoints were not updated successfully. Fallback endpoints: {config.get_list(configName)}; Code: {msg.status_code}"
        )


def post_event(type: str, url: str, data: str) -> None:
    msg = requests.post(f"{url}/{type.lower()}/", data)
    if msg.status_code == 200:
        logger.info(
            f"FCOC API update posted successfully. Type: {type}; Code: {msg.status_code}"
        )
    else:
        logger.warning(
            f"FCOC API update was not posted successfully. Type: {type}; Code: {msg.status_code}"
        )


def plugin_start3(plugin_dir: str) -> str:
    min_version = "5.0.1"
    if isinstance(appversion, str):
        core_version = semantic_version.Version(appversion)
    elif callable(appversion):
        core_version = appversion()
    if core_version < semantic_version.Version(min_version):
        logger.error(f"EDMarketConnector core version is before {min_version}")
        raise Exception("EDMarketConnector is outdated, please update.")
    events = config.get_list("FCOC_API_endpoints")
    if not events:
        logger.info("Initialising FCOC config.")
        config.set("FCOC_API_endpoints", [])
    config.set("FCOC_API_URL", "http://api.fcoc.space:8080")
    config.set("FCOC_version", "1.1.1")
    url = config.get_str("FCOC_API_URL")
    version = config.get_str("FCOC_version")
    update_endpoints_thread = Thread(
        target=update_endpoints, args=(url, "FCOC_API_endpoints")
    )
    update_endpoints_thread.start()
    logger.info(f"FCOC API client loaded successfully. Version {version}")
    return "FCOC-API"


def journal_entry(
    cmdr: str,
    is_beta: bool,
    system: str,
    station: str,
    entry: Dict[str, Any],
    state: Dict[str, Any],
) -> Optional[str]:
    if entry["event"].lower() in config.get_list("FCOC_API_endpoints"):
        game_mode = "Legacy"
        if monitor.is_live_galaxy():
            game_mode = "Horizons"
        if state["Odyssey"]:
            game_mode = "Odyssey"
        url = config.get_str("FCOC_API_URL")
        entry["game_mode"] = game_mode
        post_event_thread = Thread(
            target=post_event, args=(entry["event"], url, json.dumps(entry))
        )
        post_event_thread.start()
