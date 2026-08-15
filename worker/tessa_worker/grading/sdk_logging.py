import logging

SDK_LOGGER_NAMES = ("openai", "anthropic", "httpx2", "httpcore2")


def quiet_sdk_loggers() -> None:
    for name in SDK_LOGGER_NAMES:
        logging.getLogger(name).setLevel(logging.WARNING)
