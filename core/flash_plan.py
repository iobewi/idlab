"""Validate a flash plan against the measured capacity and erase sectors."""

import base64
import hashlib
import re


SECTOR_SIZE = 4096
MAX_FLASH = 64 * 1024 * 1024
MAX_PROGRAM_BODY = (MAX_FLASH + 2) // 3 * 4 + 8192


def validate_images(images, capacity):
    if not isinstance(images, list) or not 1 <= len(images) <= 16:
        raise ValueError("invalid_flash_plan")
    for image in images:
        if not isinstance(image, dict) or image.keys() != {"address", "size", "sha256"}:
            raise ValueError("invalid_flash_plan")
        address, size, digest = image["address"], image["size"], image["sha256"]
        if (type(address) is not int or address < 0 or address % SECTOR_SIZE or
                type(size) is not int or size <= 0 or
                not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)):
            raise ValueError("invalid_flash_plan")
    end = 0
    for image in sorted(images, key=lambda image: image["address"]):
        address = image["address"]
        sectors = (image["size"] + SECTOR_SIZE - 1) // SECTOR_SIZE
        if address < end or address + sectors * SECTOR_SIZE > min(capacity, MAX_FLASH):
            raise ValueError("invalid_flash_range")
        end = address + sectors * SECTOR_SIZE


def decode_images(encoded, images):
    if not isinstance(encoded, list) or len(encoded) != len(images):
        raise ValueError("invalid_flash_images")
    binaries = []
    for text, image in zip(encoded, images, strict=True):
        size = image["size"]
        if not isinstance(text, str) or len(text) != 4 * ((size + 2) // 3):
            raise ValueError("invalid_flash_images")
        try:
            data = base64.b64decode(text, validate=True)
        except ValueError as error:
            raise ValueError("invalid_flash_images") from error
        if len(data) != size or hashlib.sha256(data).hexdigest() != image["sha256"]:
            raise ValueError("flash_image_mismatch")
        binaries.append(data)
    return binaries
