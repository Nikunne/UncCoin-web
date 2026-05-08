#In prod, this is located in /home/hus/krypto/
from pathlib import Path
import shutil
import time
import hashlib
import logging

SOURCE_DIR = Path("/home/hus/krypto/UncCoin")
DEST_DIR = Path("/home/hus/krypto/UncCoin-web/backend")
INTERVAL_SECONDS = 3
ALLOWED_FILES = ("blockchain.json", "penger.txt")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)

known_hashes = {}


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def iter_files():
    for name in ALLOWED_FILES:
        path = SOURCE_DIR / name
        if path.is_file():
            yield path


def copy_files():
    files = list(iter_files())

    if not files:
        logging.info("No matching files found in %s", SOURCE_DIR)
        return

    DEST_DIR.mkdir(parents=True, exist_ok=True)

    for src_file in files:
        try:
            current_hash = file_hash(src_file)
            previous_hash = known_hashes.get(src_file.name)
            destination = DEST_DIR / src_file.name

            if current_hash != previous_hash:
                shutil.copy2(src_file, destination)
                known_hashes[src_file.name] = current_hash
                logging.info("Copied %s -> %s", src_file, destination)
            else:
                logging.info("No change: %s", src_file.name)

        except Exception as e:
            logging.exception("Failed handling %s: %s", src_file, e)


def main():
    logging.info("Starting file copy agent")
    logging.info("Watching: %s", SOURCE_DIR)
    logging.info("Copying to: %s", DEST_DIR)
    logging.info("Allowed files: %s", ", ".join(ALLOWED_FILES))
    logging.info("Interval: %s seconds", INTERVAL_SECONDS)

    while True:
        copy_files()
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
