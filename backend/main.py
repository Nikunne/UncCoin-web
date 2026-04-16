import asyncio
import hashlib
import json
import os
import re
import secrets
from collections import deque
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
WEB_ROOT = BASE_DIR.parent
UNCCOIN_REPO = (WEB_ROOT.parent / "UncCoin").resolve()
UNCCOIN_RUN_SCRIPT = UNCCOIN_REPO / "scripts" / "run.sh"
UNCCOIN_BLOCKCHAINS_DIR = UNCCOIN_REPO / "state" / "blockchains"
PENGER_FILE = BASE_DIR / "penger.txt"
BLOCKCHAIN_FILE = BASE_DIR / "blockchain.json"
BROWSER_WALLETS_FILE = BASE_DIR / "browser_wallets.json"
APP_SETTINGS_FILE = BASE_DIR / "app_settings.json"
REFRESH_SECONDS = 10
NODE_PORT_START = int(os.getenv("UNC_NODE_PORT_START", "8300"))
NODE_PORT_END = int(os.getenv("UNC_NODE_PORT_END", "8500"))
NODE_READY_TIMEOUT_SECONDS = int(os.getenv("UNC_NODE_READY_TIMEOUT_SECONDS", "45"))
SYNC_WAIT_SECONDS = int(os.getenv("UNC_SYNC_WAIT_SECONDS", "15"))
TX_WAIT_SECONDS = int(os.getenv("UNC_TX_WAIT_SECONDS", "5"))
DEFAULT_PEER_ADDRESS = os.getenv("UNC_PEER_ADDRESS", "0.0.0.0:4040").strip()
OUTPUT_BALANCES_PATH = "../UncCoin-web/backend/penger.txt"
OUTPUT_BLOCKCHAIN_PATH = "../UncCoin-web/backend/blockchain.json"
PASSWORD_ITERATIONS = 240_000
COMMAND_POLL_INTERVAL_SECONDS = 0.25
SYNC_SETTLE_IDLE_SECONDS = float(os.getenv("UNC_SYNC_SETTLE_IDLE_SECONDS", "2.5"))
SYNC_MAX_WAIT_SECONDS = int(os.getenv("UNC_SYNC_MAX_WAIT_SECONDS", "600"))
BALANCE_POLL_INTERVAL_SECONDS = float(os.getenv("UNC_BALANCE_POLL_INTERVAL_SECONDS", "2"))
BONUS_RECEIVER_ADDRESS = "c5c9f38923a71ff93e03317e5afc25e66c786aea8413caea2e48dcc4ae81c7bb"
DEFAULT_BONUS_AMOUNT = "1"
RECENT_WALLET_ACTIVITY_LIMIT = 40

balances: Dict[str, float] = {}
balances_lock = asyncio.Lock()
blockchain: Dict[str, Any] = {}
blockchain_lock = asyncio.Lock()
browser_wallets: Dict[str, Dict[str, Any]] = {}
browser_wallets_lock = asyncio.Lock()
wallet_sessions: Dict[str, Dict[str, str]] = {}
wallet_sessions_lock = asyncio.Lock()
node_command_lock = asyncio.Lock()
refresh_task: asyncio.Task | None = None
WALLET_NAME_PATTERN = re.compile(r"[^a-z0-9-]+")
app_settings: Dict[str, str] = {"bonus_amount": DEFAULT_BONUS_AMOUNT}
app_settings_lock = asyncio.Lock()


class WalletLoginRequest(BaseModel):
    wallet_address: str
    password: str


class BrowserWalletCreateRequest(BaseModel):
    wallet_name: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=6, max_length=200)


class BrowserWalletSendRequest(BaseModel):
    receiver_address: str
    amount: str
    fee: str = "0"


class BonusAmountUpdateRequest(BaseModel):
    bonus_amount: str


class BrowserWalletRecord(BaseModel):
    wallet_address: str
    wallet_name: str
    created_at: str


class BrowserWalletSessionResponse(BaseModel):
    ok: bool
    token: str
    browser_wallet: BrowserWalletRecord
    wallet: Dict[str, Any]


def load_app_settings_file() -> Dict[str, str]:
    if not APP_SETTINGS_FILE.exists():
        return {"bonus_amount": DEFAULT_BONUS_AMOUNT}

    try:
        parsed = json.loads(APP_SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"Error reading {APP_SETTINGS_FILE}: {error}")
        return {"bonus_amount": DEFAULT_BONUS_AMOUNT}

    if not isinstance(parsed, dict):
        return {"bonus_amount": DEFAULT_BONUS_AMOUNT}

    bonus_amount = parsed.get("bonus_amount", DEFAULT_BONUS_AMOUNT)
    return {"bonus_amount": str(bonus_amount)}


async def save_app_settings_file() -> None:
    async with app_settings_lock:
        APP_SETTINGS_FILE.write_text(json.dumps(app_settings, indent=2), encoding="utf-8")


def parse_amount(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def parse_timestamp(value: Any) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None

    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"

    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)

    return parsed.timestamp()


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def sanitize_wallet_label(wallet_name: str) -> str:
    lowered = wallet_name.strip().lower().replace("_", "-").replace(" ", "-")
    normalized = WALLET_NAME_PATTERN.sub("-", lowered).strip("-")
    return normalized or "browser-wallet"


def hash_password(password: str, salt_hex: str | None = None) -> tuple[str, str]:
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_ITERATIONS,
    )
    return salt.hex(), digest.hex()


def verify_password(password: str, salt_hex: str, password_hash: str) -> bool:
    _, candidate_hash = hash_password(password, salt_hex)
    return secrets.compare_digest(candidate_hash, password_hash)


def collect_wallet_addresses(chain_data: Dict[str, Any]) -> set[str]:
    wallet_addresses: set[str] = set()

    chain_wallet_address = chain_data.get("wallet_address")
    if isinstance(chain_wallet_address, str) and chain_wallet_address.strip():
        wallet_addresses.add(chain_wallet_address.strip())

    for block in chain_data.get("blocks", []):
        description = block.get("description")
        if isinstance(description, str) and description.strip():
            wallet_addresses.add(description.strip())

        for transaction in block.get("transactions", []):
            sender = transaction.get("sender")
            receiver = transaction.get("receiver")

            if isinstance(sender, str) and sender.strip():
                wallet_addresses.add(sender.strip())

            if isinstance(receiver, str) and receiver.strip():
                wallet_addresses.add(receiver.strip())

    return wallet_addresses


def build_wallet_stats(
    wallet_address: str,
    balance: float,
    chain_data: Dict[str, Any],
    activity_limit: int | None = None,
) -> Dict[str, Any]:
    blocks = chain_data.get("blocks", [])
    sent_count = 0
    received_count = 0
    total_sent = 0.0
    total_received = 0.0
    total_fees_paid = 0.0
    mined_block_count = 0
    block_appearance_count = 0
    latest_activity: str | None = None
    activity: list[Dict[str, Any]] = []

    for block in blocks:
        transactions = block.get("transactions", [])
        block_has_wallet_activity = False
        mining_reward_in_block = 0.0
        block_timestamp: str | None = None

        for transaction in transactions:
            amount = parse_amount(transaction.get("amount"))
            fee = parse_amount(transaction.get("fee"))
            sender = transaction.get("sender")
            receiver = transaction.get("receiver")
            timestamp = transaction.get("timestamp")

            if not block_timestamp and isinstance(timestamp, str) and timestamp.strip():
                block_timestamp = timestamp

            if sender == wallet_address:
                sent_count += 1
                total_sent += amount
                total_fees_paid += fee
                block_has_wallet_activity = True
                activity.append(
                    {
                        "block_id": block.get("block_id"),
                        "kind": "sent",
                        "sender": sender,
                        "receiver": receiver,
                        "amount": amount,
                        "fee": fee,
                        "timestamp": timestamp,
                    }
                )
                if timestamp:
                    latest_activity = timestamp

            if receiver == wallet_address:
                received_count += 1
                total_received += amount
                block_has_wallet_activity = True
                if sender == "SYSTEM":
                    mining_reward_in_block += amount
                activity.append(
                    {
                        "block_id": block.get("block_id"),
                        "kind": "mined" if sender == "SYSTEM" and block.get("description") == wallet_address else "received",
                        "sender": sender,
                        "receiver": receiver,
                        "amount": amount,
                        "fee": fee,
                        "timestamp": timestamp,
                    }
                )
                if timestamp:
                    latest_activity = timestamp

        if block.get("description") == wallet_address:
            mined_block_count += 1
            if mining_reward_in_block <= 0:
                activity.append(
                    {
                        "block_id": block.get("block_id"),
                        "kind": "mined",
                        "sender": "SYSTEM",
                        "receiver": wallet_address,
                        "amount": 0.0,
                        "fee": 0.0,
                        "timestamp": block_timestamp,
                    }
                )

        if block_has_wallet_activity:
            block_appearance_count += 1

    activity.sort(
        key=lambda entry: (
            parse_timestamp(entry.get("timestamp")) or float("-inf"),
            entry.get("block_id") if isinstance(entry.get("block_id"), int) else -1,
        ),
        reverse=True,
    )

    latest_activity = next(
        (
            entry.get("timestamp")
            for entry in activity
            if isinstance(entry.get("timestamp"), str) and entry.get("timestamp").strip()
        ),
        latest_activity,
    )

    if isinstance(activity_limit, int) and activity_limit >= 0:
        activity = activity[:activity_limit]

    return {
        "wallet_address": wallet_address,
        "balance": balance,
        "transaction_count": sent_count + received_count,
        "sent_count": sent_count,
        "received_count": received_count,
        "total_sent": total_sent,
        "total_received": total_received,
        "total_fees_paid": total_fees_paid,
        "mined_block_count": mined_block_count,
        "block_appearance_count": block_appearance_count,
        "latest_activity": latest_activity,
        "activity": activity,
    }


async def get_wallet_balance(wallet_address: str) -> float | None:
    async with balances_lock:
        return balances.get(wallet_address)


async def get_wallet_summary(
    wallet_address: str,
    require_chain_presence: bool = True,
    activity_limit: int | None = None,
) -> Dict[str, Any]:
    async with blockchain_lock:
        chain_data = dict(blockchain)

    if require_chain_presence and wallet_address not in collect_wallet_addresses(chain_data):
        raise HTTPException(status_code=404, detail="Wallet address not found in blockchain data")

    balance = await get_wallet_balance(wallet_address)
    return build_wallet_stats(wallet_address, balance or 0.0, chain_data, activity_limit=activity_limit)


async def ensure_wallet_exists_on_chain(wallet_address: str) -> None:
    normalized_address = wallet_address.strip()
    if not normalized_address:
        raise HTTPException(status_code=400, detail="Receiver wallet address is required")

    async with blockchain_lock:
        chain_data = dict(blockchain)

    if not chain_data:
        await load_blockchain_once()
        async with blockchain_lock:
            chain_data = dict(blockchain)

    if normalized_address not in collect_wallet_addresses(chain_data):
        raise HTTPException(status_code=400, detail="Receiver wallet address does not exist on-chain")


async def get_bonus_amount_setting() -> str:
    async with app_settings_lock:
        return str(app_settings.get("bonus_amount", DEFAULT_BONUS_AMOUNT))


async def set_bonus_amount_setting(bonus_amount: str) -> str:
    normalized_bonus_amount = bonus_amount.strip()
    parse_decimal_amount(normalized_bonus_amount, "Bonus amount")

    async with app_settings_lock:
        app_settings["bonus_amount"] = normalized_bonus_amount

    await save_app_settings_file()
    return normalized_bonus_amount


def parse_decimal_amount(value: str, field_name: str) -> Decimal:
    try:
        parsed = Decimal(value.strip())
    except (AttributeError, InvalidOperation) as error:
        raise HTTPException(status_code=400, detail=f"{field_name} must be a valid decimal number") from error

    if parsed < 0:
        raise HTTPException(status_code=400, detail=f"{field_name} must be zero or greater")

    return parsed


def parse_penger_file(text: str) -> Dict[str, float]:
    parsed: Dict[str, float] = {}

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if line.endswith(":") and ":" not in line[:-1]:
            continue

        if ":" not in line:
            continue

        wallet, amount_str = line.split(":", 1)
        wallet = wallet.strip()
        amount_str = amount_str.strip()

        if not wallet:
            continue

        try:
            parsed[wallet] = float(amount_str)
        except ValueError:
            continue

    return parsed


def load_browser_wallets_file() -> Dict[str, Dict[str, Any]]:
    if not BROWSER_WALLETS_FILE.exists():
        return {}

    try:
        parsed = json.loads(BROWSER_WALLETS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"Error reading {BROWSER_WALLETS_FILE}: {error}")
        return {}

    if not isinstance(parsed, dict):
        return {}

    wallets = parsed.get("wallets", {})
    return wallets if isinstance(wallets, dict) else {}


async def save_browser_wallets_file() -> None:
    async with browser_wallets_lock:
        payload = {"wallets": browser_wallets}
        BROWSER_WALLETS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


async def load_balances_once() -> None:
    if not PENGER_FILE.exists():
        return

    try:
        text = PENGER_FILE.read_text(encoding="utf-8")
    except FileNotFoundError:
        print(f"Error: {PENGER_FILE} not found.")
        return
    except Exception as error:
        print(f"Error reading {PENGER_FILE}: {error}")
        return

    parsed = parse_penger_file(text)

    async with balances_lock:
        balances.clear()
        balances.update(parsed)


async def load_blockchain_once() -> None:
    if not BLOCKCHAIN_FILE.exists():
        return

    try:
        text = BLOCKCHAIN_FILE.read_text(encoding="utf-8")
        parsed = json.loads(text)
    except FileNotFoundError:
        print(f"Error: {BLOCKCHAIN_FILE} not found.")
        return
    except json.JSONDecodeError as error:
        print(f"Error parsing {BLOCKCHAIN_FILE}: {error}")
        return
    except Exception as error:
        print(f"Error reading {BLOCKCHAIN_FILE}: {error}")
        return

    if not isinstance(parsed, dict):
        print(f"Error: {BLOCKCHAIN_FILE} does not contain a JSON object.")
        return

    async with blockchain_lock:
        blockchain.clear()
        blockchain.update(parsed)


async def seed_wallet_blockchain_state(wallet_address: str) -> None:
    async with blockchain_lock:
        chain_data = dict(blockchain)

    if not chain_data:
        await load_blockchain_once()
        async with blockchain_lock:
            chain_data = dict(blockchain)

    if not chain_data:
        raise HTTPException(status_code=503, detail="Backend blockchain snapshot is not loaded")

    seeded_state = dict(chain_data)
    seeded_state["wallet_address"] = wallet_address

    UNCCOIN_BLOCKCHAINS_DIR.mkdir(parents=True, exist_ok=True)
    target_path = UNCCOIN_BLOCKCHAINS_DIR / f"{wallet_address}.json"
    target_path.write_text(json.dumps(seeded_state, indent=2), encoding="utf-8")


async def refresh_loop() -> None:
    while True:
        await load_balances_once()
        await load_blockchain_once()
        await asyncio.sleep(REFRESH_SECONDS)


async def register_browser_wallet(wallet_address: str, wallet_name: str, password: str, internal_wallet_name: str) -> Dict[str, Any]:
    salt_hex, password_hash = hash_password(password)
    node_port = await allocate_node_port()
    record = {
        "wallet_address": wallet_address,
        "wallet_name": wallet_name,
        "internal_wallet_name": internal_wallet_name,
        "node_port": node_port,
        "created_at": now_iso(),
        "password_salt": salt_hex,
        "password_hash": password_hash,
    }

    async with browser_wallets_lock:
        browser_wallets[wallet_address] = record

    await save_browser_wallets_file()
    return record


async def get_browser_wallet(wallet_address: str) -> Dict[str, Any] | None:
    async with browser_wallets_lock:
        record = browser_wallets.get(wallet_address)
        return dict(record) if record else None


async def find_browser_wallet_by_login(login_identifier: str) -> Dict[str, Any] | None:
    normalized_identifier = login_identifier.strip()
    if not normalized_identifier:
        return None

    async with browser_wallets_lock:
        direct_match = browser_wallets.get(normalized_identifier)
        if direct_match:
            return dict(direct_match)

        lowered_identifier = normalized_identifier.casefold()
        for record in browser_wallets.values():
            wallet_name = record.get("wallet_name")
            if isinstance(wallet_name, str) and wallet_name.casefold() == lowered_identifier:
                return dict(record)

    return None


async def allocate_node_port() -> int:
    async with browser_wallets_lock:
        used_ports = {
            int(record["node_port"])
            for record in browser_wallets.values()
            if isinstance(record, dict) and str(record.get("node_port", "")).isdigit()
        }

    for candidate in range(NODE_PORT_START, NODE_PORT_END + 1):
        if candidate not in used_ports:
            return candidate

    raise HTTPException(
        status_code=503,
        detail=f"No wallet node ports available in range {NODE_PORT_START}-{NODE_PORT_END}",
    )


async def create_session_for_wallet(wallet_record: Dict[str, Any]) -> str:
    token = secrets.token_urlsafe(32)
    async with wallet_sessions_lock:
        wallet_sessions[token] = {
            "wallet_address": wallet_record["wallet_address"],
            "created_at": now_iso(),
        }
    return token


async def get_wallet_address_for_token(token: str) -> str | None:
    async with wallet_sessions_lock:
        session = wallet_sessions.get(token)
        return session.get("wallet_address") if session else None


async def delete_session(token: str) -> None:
    async with wallet_sessions_lock:
        wallet_sessions.pop(token, None)


def require_bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing authorization token")

    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        raise HTTPException(status_code=401, detail="Invalid authorization token")

    return value.strip()


async def require_authenticated_browser_wallet(authorization: str | None) -> Dict[str, Any]:
    token = require_bearer_token(authorization)
    wallet_address = await get_wallet_address_for_token(token)
    if not wallet_address:
        raise HTTPException(status_code=401, detail="Session expired or invalid")

    wallet_record = await get_browser_wallet(wallet_address)
    if not wallet_record:
        await delete_session(token)
        raise HTTPException(status_code=401, detail="Wallet session is no longer valid")

    return wallet_record


def format_browser_wallet_record(record: Dict[str, Any]) -> Dict[str, Any]:
    return BrowserWalletRecord(
        wallet_address=record["wallet_address"],
        wallet_name=record["wallet_name"],
        created_at=record["created_at"],
    ).model_dump()


async def run_subprocess(command: list[str], cwd: Path) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await process.communicate()
    return process.returncode or 0, stdout.decode("utf-8", errors="replace")


async def create_unccoin_wallet(wallet_label: str) -> tuple[str, str]:
    if not UNCCOIN_REPO.exists():
        raise HTTPException(status_code=500, detail=f"Missing UncCoin repo at {UNCCOIN_REPO}")

    cleaned_label = sanitize_wallet_label(wallet_label)
    internal_wallet_name = f"browser-{cleaned_label}-{secrets.token_hex(4)}"
    command = ["python3", "-m", "wallet.cli", "create", "--name", internal_wallet_name]
    exit_code, output = await run_subprocess(command, UNCCOIN_REPO)

    if exit_code != 0:
        raise HTTPException(status_code=500, detail=f"Wallet creation failed:\n{output.strip()}")

    address_line = next((line for line in output.splitlines() if line.startswith("Address: ")), "")
    wallet_address = address_line.replace("Address: ", "", 1).strip()
    if not wallet_address:
        raise HTTPException(status_code=500, detail=f"Could not parse wallet address from output:\n{output.strip()}")

    return internal_wallet_name, wallet_address


async def resolve_unccoin_wallet_address(wallet_name: str) -> str:
    command = ["python3", "-m", "wallet.cli", "show", "--name", wallet_name]
    exit_code, output = await run_subprocess(command, UNCCOIN_REPO)

    if exit_code != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to load local UncCoin wallet '{wallet_name}'.\n{output.strip()}",
        )

    address_line = next((line for line in output.splitlines() if line.startswith("Address: ")), "")
    wallet_address = address_line.replace("Address: ", "", 1).strip()
    if not wallet_address:
        raise HTTPException(
            status_code=500,
            detail=f"Could not parse wallet address for local UncCoin wallet '{wallet_name}'.\n{output.strip()}",
        )

    return wallet_address


async def verify_wallet_record_identity(wallet_record: Dict[str, Any]) -> None:
    local_wallet_address = await resolve_unccoin_wallet_address(wallet_record["internal_wallet_name"])
    expected_wallet_address = wallet_record["wallet_address"]

    if local_wallet_address != expected_wallet_address:
        raise HTTPException(
            status_code=409,
            detail=(
                "Local wallet mapping mismatch. "
                f"Stored browser wallet address is {expected_wallet_address}, "
                f"but local UncCoin wallet '{wallet_record['internal_wallet_name']}' resolves to {local_wallet_address}."
            ),
        )


class InteractiveNodeRunner:
    def __init__(self, wallet_name: str, node_port: int):
        self.wallet_name = wallet_name
        self.node_port = node_port
        self.process: asyncio.subprocess.Process | None = None
        self.ready_event = asyncio.Event()
        self.output_lines: deque[str] = deque(maxlen=400)
        self.stream_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        command = [str(UNCCOIN_RUN_SCRIPT), self.wallet_name, str(self.node_port)]

        self.process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(UNCCOIN_REPO),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self.stream_task = asyncio.create_task(self._stream_output())

    async def _stream_output(self) -> None:
        if self.process is None or self.process.stdout is None:
            return

        while True:
            line = await self.process.stdout.readline()
            if not line:
                break

            decoded = line.decode("utf-8", errors="replace").rstrip()
            self.output_lines.append(decoded)

            if "Node ready." in decoded:
                self.ready_event.set()

    def tail_output(self) -> str:
        return "\n".join(self.output_lines).strip()

    async def wait_for_output(
        self,
        success_markers: list[str],
        failure_markers: list[str] | None = None,
        timeout_seconds: int = 15,
    ) -> str:
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        failure_markers = failure_markers or []

        while True:
            output = self.tail_output()

            for marker in failure_markers:
                if marker in output:
                    return marker

            for marker in success_markers:
                if marker in output:
                    return marker

            if self.process is not None and self.process.returncode is not None:
                raise HTTPException(
                    status_code=500,
                    detail=f"Node exited unexpectedly.\n{output}",
                )

            if asyncio.get_running_loop().time() >= deadline:
                raise HTTPException(
                    status_code=504,
                    detail=f"Timed out waiting for node response.\n{output}",
                )

            await asyncio.sleep(COMMAND_POLL_INTERVAL_SECONDS)

    async def wait_for_sync_settle(
        self,
        timeout_seconds: int,
        idle_seconds: float = SYNC_SETTLE_IDLE_SECONDS,
    ) -> None:
        sync_markers = [
            "Chain chunk received from ",
            "Requesting next chain chunk from ",
            "Chain sync chunk processed: ",
            "Chain sync from ",
        ]

        deadline = asyncio.get_running_loop().time() + timeout_seconds
        start_time = asyncio.get_running_loop().time()
        last_seen_sync_activity: float | None = None
        seen_sync_activity = False
        inspected_count = 0

        while True:
            current_time = asyncio.get_running_loop().time()
            output_snapshot = list(self.output_lines)
            new_lines = output_snapshot[inspected_count:]
            inspected_count = len(output_snapshot)

            for line in new_lines:
                if any(marker in line for marker in sync_markers):
                    seen_sync_activity = True
                    last_seen_sync_activity = current_time

                if "Stopping automatic sync." in line:
                    return

            if seen_sync_activity and last_seen_sync_activity is not None:
                if current_time - last_seen_sync_activity >= idle_seconds:
                    return
            elif current_time - start_time >= idle_seconds:
                return

            if self.process is not None and self.process.returncode is not None:
                raise HTTPException(
                    status_code=500,
                    detail=f"Node exited unexpectedly during sync.\n{self.tail_output()}",
                )

            if current_time >= deadline:
                raise HTTPException(
                    status_code=504,
                    detail=f"Timed out waiting for blockchain sync to settle.\n{self.tail_output()}",
                )

            await asyncio.sleep(COMMAND_POLL_INTERVAL_SECONDS)

    async def query_wallet_balance(self) -> Decimal | None:
        if self.process is None:
            return None

        marker_before = len(self.output_lines)
        await self.send_command("balance")
        deadline = asyncio.get_running_loop().time() + 10

        while True:
            output_snapshot = list(self.output_lines)
            new_lines = output_snapshot[marker_before:]

            for line in new_lines:
                if "Balance for " not in line:
                    continue

                _, _, balance_text = line.rpartition(": ")
                try:
                    return Decimal(balance_text.strip())
                except InvalidOperation:
                    return None

            if self.process is not None and self.process.returncode is not None:
                return None

            if asyncio.get_running_loop().time() >= deadline:
                return None

            await asyncio.sleep(COMMAND_POLL_INTERVAL_SECONDS)

    async def wait_until_ready(self) -> None:
        if self.process is None:
            raise RuntimeError("Node process is not running")

        try:
            await asyncio.wait_for(self.ready_event.wait(), timeout=NODE_READY_TIMEOUT_SECONDS)
        except TimeoutError as error:
            raise HTTPException(
                status_code=504,
                detail=f"Timed out waiting for node startup.\n{self.tail_output()}",
            ) from error

    async def send_command(self, command: str) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("Node process stdin is unavailable")

        self.process.stdin.write(f"{command}\n".encode("utf-8"))
        await self.process.stdin.drain()
        self.output_lines.append(f"> {command}")

    async def sleep(self, seconds: int) -> None:
        await asyncio.sleep(seconds)

    async def close(self) -> None:
        if self.process is None:
            return

        if self.process.returncode is None:
            try:
                await self.send_command("quit")
                await asyncio.wait_for(self.process.wait(), timeout=10)
            except Exception:
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=5)
                except Exception:
                    self.process.kill()
                    await self.process.wait()

        if self.stream_task is not None:
            await self.stream_task


async def sync_local_exports() -> None:
    await load_balances_once()
    await load_blockchain_once()


async def send_unccoin_transaction(wallet_record: Dict[str, Any], receiver_address: str, amount: str, fee: str) -> str:
    return await send_unccoin_transaction_with_bonus(
        wallet_record=wallet_record,
        receiver_address=receiver_address,
        amount=amount,
        fee=fee,
        bonus_amount=await get_bonus_amount_setting(),
    )


async def broadcast_tx_command(
    runner: InteractiveNodeRunner,
    receiver_address: str,
    amount: str,
    fee: str,
) -> None:
    await runner.send_command(f"tx {receiver_address.strip()} {amount.strip()} {fee.strip()}")
    tx_result = await runner.wait_for_output(
        success_markers=["Broadcast transaction "],
        failure_markers=["Invalid tx command:", "Rejected local transaction "],
        timeout_seconds=max(TX_WAIT_SECONDS, 15),
    )
    if tx_result == "Invalid tx command:":
        output = runner.tail_output()
        detail = output.rsplit("Invalid tx command:", maxsplit=1)[-1].strip()
        raise HTTPException(status_code=400, detail=f"Transaction rejected: {detail}")
    if tx_result == "Rejected local transaction ":
        output = runner.tail_output()
        detail = output.rsplit("Rejected local transaction ", maxsplit=1)[-1].strip()
        raise HTTPException(status_code=400, detail=f"Transaction rejected: {detail}")


async def send_unccoin_transaction_with_bonus(
    wallet_record: Dict[str, Any],
    receiver_address: str,
    amount: str,
    fee: str,
    bonus_amount: str,
) -> str:
    if not receiver_address.strip():
        raise HTTPException(status_code=400, detail="Receiver wallet address is required")

    await ensure_wallet_exists_on_chain(receiver_address)
    await ensure_wallet_exists_on_chain(BONUS_RECEIVER_ADDRESS)

    primary_amount = parse_decimal_amount(amount, "Amount")
    primary_fee = parse_decimal_amount(fee, "Fee")
    bonus_decimal = parse_decimal_amount(bonus_amount, "Bonus amount")
    required_total = primary_amount + primary_fee + bonus_decimal

    async with node_command_lock:
        await verify_wallet_record_identity(wallet_record)
        await seed_wallet_blockchain_state(wallet_record["wallet_address"])
        node_port = int(wallet_record["node_port"])
        runner = InteractiveNodeRunner(wallet_record["internal_wallet_name"], node_port)

        try:
            await runner.start()
            await runner.wait_until_ready()
            if DEFAULT_PEER_ADDRESS:
                await runner.send_command(f"add-peer {DEFAULT_PEER_ADDRESS}")
                add_peer_result = await runner.wait_for_output(
                    success_markers=[f"Connected to peer {DEFAULT_PEER_ADDRESS}"],
                    failure_markers=["Invalid add-peer command:"],
                    timeout_seconds=10,
                )
                if add_peer_result == "Invalid add-peer command:":
                    output = runner.tail_output()
                    detail = output.rsplit("Invalid add-peer command:", maxsplit=1)[-1].strip()
                    raise HTTPException(status_code=400, detail=f"Peer connection failed: {detail}")
            await runner.send_command("sync")
            sync_deadline = asyncio.get_running_loop().time() + max(SYNC_WAIT_SECONDS, SYNC_MAX_WAIT_SECONDS)
            while True:
                current_balance = await runner.query_wallet_balance()
                if current_balance is not None and current_balance >= required_total:
                    break

                if asyncio.get_running_loop().time() >= sync_deadline:
                    raise HTTPException(
                        status_code=504,
                        detail=(
                            "Timed out waiting for the wallet balance to sync high enough for this transaction.\n"
                            f"Needed: {required_total}\n"
                            f"Current balance: {current_balance if current_balance is not None else 'unknown'}\n"
                            f"{runner.tail_output()}"
                        ),
                    )

                await runner.wait_for_sync_settle(timeout_seconds=15)
                await asyncio.sleep(BALANCE_POLL_INTERVAL_SECONDS)

            await broadcast_tx_command(runner, receiver_address, amount, fee)
            if bonus_decimal > 0:
                await broadcast_tx_command(runner, BONUS_RECEIVER_ADDRESS, str(bonus_decimal), "0")
            await runner.send_command(f"txtbalances {OUTPUT_BALANCES_PATH}")
            await runner.send_command(f"txtblockchain {OUTPUT_BLOCKCHAIN_PATH}")
            await runner.sleep(2)
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(status_code=500, detail=f"Failed to send transaction: {error}") from error
        finally:
            await runner.close()

        output = runner.tail_output()
        await sync_local_exports()
        return output


@asynccontextmanager
async def lifespan(app: FastAPI):
    global refresh_task

    async with browser_wallets_lock:
        browser_wallets.clear()
        browser_wallets.update(load_browser_wallets_file())
        migrated = False
        used_ports: set[int] = set()
        for wallet_address, record in browser_wallets.items():
            if not isinstance(record, dict):
                continue

            raw_port = record.get("node_port")
            if isinstance(raw_port, int):
                used_ports.add(raw_port)
                continue

            if isinstance(raw_port, str) and raw_port.isdigit():
                record["node_port"] = int(raw_port)
                used_ports.add(record["node_port"])
                migrated = True
                continue

            for candidate in range(NODE_PORT_START, NODE_PORT_END + 1):
                if candidate not in used_ports:
                    record["node_port"] = candidate
                    used_ports.add(candidate)
                    migrated = True
                    break
            else:
                raise RuntimeError(
                    f"No wallet node ports available in range {NODE_PORT_START}-{NODE_PORT_END}"
                )

        if migrated:
            BROWSER_WALLETS_FILE.write_text(
                json.dumps({"wallets": browser_wallets}, indent=2),
                encoding="utf-8",
            )

    async with app_settings_lock:
        app_settings.clear()
        app_settings.update(load_app_settings_file())

    await load_balances_once()
    await load_blockchain_once()
    refresh_task = asyncio.create_task(refresh_loop())

    try:
        yield
    finally:
        if refresh_task:
            refresh_task.cancel()
            try:
                await refresh_task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Wallet Balances API", lifespan=lifespan)


@app.get("/balances")
async def get_balances() -> Dict[str, float]:
    async with balances_lock:
        return dict(balances)


@app.get("/blockchain")
async def get_blockchain() -> Dict[str, Any]:
    async with blockchain_lock:
        payload = dict(blockchain)

    async with browser_wallets_lock:
        payload["wallet_names"] = {
            wallet_address: str(record.get("wallet_name", "")).strip()
            for wallet_address, record in browser_wallets.items()
            if isinstance(record, dict) and str(record.get("wallet_name", "")).strip()
        }

    return payload


@app.post("/wallet-login")
async def wallet_login(payload: WalletLoginRequest) -> BrowserWalletSessionResponse:
    login_identifier = payload.wallet_address.strip()

    if not login_identifier:
        raise HTTPException(status_code=400, detail="Wallet name or address is required")

    wallet_record = await find_browser_wallet_by_login(login_identifier)
    if not wallet_record:
        raise HTTPException(status_code=401, detail="Unknown browser wallet name or address")

    if not verify_password(payload.password, wallet_record["password_salt"], wallet_record["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid wallet name/address or password")

    token = await create_session_for_wallet(wallet_record)
    summary = await get_wallet_summary(
        wallet_record["wallet_address"],
        require_chain_presence=False,
        activity_limit=RECENT_WALLET_ACTIVITY_LIMIT,
    )

    return BrowserWalletSessionResponse(
        ok=True,
        token=token,
        browser_wallet=format_browser_wallet_record(wallet_record),
        wallet=summary,
    )


@app.post("/browser-wallets")
async def create_browser_wallet(payload: BrowserWalletCreateRequest) -> BrowserWalletSessionResponse:
    internal_wallet_name, wallet_address = await create_unccoin_wallet(payload.wallet_name)
    wallet_record = await register_browser_wallet(
        wallet_address=wallet_address,
        wallet_name=payload.wallet_name.strip(),
        password=payload.password,
        internal_wallet_name=internal_wallet_name,
    )
    token = await create_session_for_wallet(wallet_record)
    summary = await get_wallet_summary(
        wallet_address,
        require_chain_presence=False,
        activity_limit=RECENT_WALLET_ACTIVITY_LIMIT,
    )

    return BrowserWalletSessionResponse(
        ok=True,
        token=token,
        browser_wallet=format_browser_wallet_record(wallet_record),
        wallet=summary,
    )


@app.get("/wallet-session")
async def get_wallet_session(authorization: str | None = Header(default=None)) -> Dict[str, Any]:
    wallet_record = await require_authenticated_browser_wallet(authorization)
    summary = await get_wallet_summary(
        wallet_record["wallet_address"],
        require_chain_presence=False,
        activity_limit=RECENT_WALLET_ACTIVITY_LIMIT,
    )
    return {
        "ok": True,
        "browser_wallet": format_browser_wallet_record(wallet_record),
        "wallet": summary,
        "bonus_amount": await get_bonus_amount_setting(),
    }


@app.post("/wallet-session/logout")
async def logout_wallet_session(authorization: str | None = Header(default=None)) -> Dict[str, bool]:
    token = require_bearer_token(authorization)
    await delete_session(token)
    return {"ok": True}


@app.post("/wallet-send")
async def wallet_send(
    payload: BrowserWalletSendRequest,
    authorization: str | None = Header(default=None),
) -> Dict[str, Any]:
    wallet_record = await require_authenticated_browser_wallet(authorization)
    bonus_amount = await get_bonus_amount_setting()
    command_output = await send_unccoin_transaction_with_bonus(
        wallet_record=wallet_record,
        receiver_address=payload.receiver_address,
        amount=payload.amount,
        fee=payload.fee,
        bonus_amount=bonus_amount,
    )
    wallet = await get_wallet_summary(
        wallet_record["wallet_address"],
        require_chain_presence=False,
        activity_limit=RECENT_WALLET_ACTIVITY_LIMIT,
    )
    return {
        "ok": True,
        "wallet": wallet,
        "browser_wallet": format_browser_wallet_record(wallet_record),
        "command_output": command_output,
        "bonus_amount": bonus_amount,
    }


@app.get("/bonus-amount")
async def get_bonus_amount(authorization: str | None = Header(default=None)) -> Dict[str, Any]:
    await require_authenticated_browser_wallet(authorization)
    return {
        "ok": True,
        "bonus_amount": await get_bonus_amount_setting(),
    }


@app.post("/bonus-amount")
async def update_bonus_amount(
    payload: BonusAmountUpdateRequest,
    authorization: str | None = Header(default=None),
) -> Dict[str, Any]:
    await require_authenticated_browser_wallet(authorization)
    bonus_amount = await set_bonus_amount_setting(payload.bonus_amount)
    return {
        "ok": True,
        "bonus_amount": bonus_amount,
    }


@app.get("/wallets/{wallet_address}")
async def get_wallet(wallet_address: str) -> Dict[str, Any]:
    return await get_wallet_summary(wallet_address)


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}
