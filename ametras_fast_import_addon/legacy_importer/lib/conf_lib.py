# pylint: skip-file
# flake8: noqa
import sys

if sys.version_info >= (3, 0, 0):
    pass
else:
    pass
import logging
import sys


def init_logger():
    logger_err = logging.getLogger("error")
    logger_err.setLevel(logging.INFO)
    err = logging.StreamHandler(sys.stderr)
    logger_err.addHandler(err)
    logger = logging.getLogger("info")
    logger.setLevel(logging.INFO)
    out = logging.StreamHandler(sys.stdout)
    logger.addHandler(out)


def log_info(msg):
    logging.getLogger("info").info(msg)


def log_error(msg):
    logging.getLogger("error").info(msg)


def log(msg):
    log_info(msg)
    log_error(msg)


init_logger()
