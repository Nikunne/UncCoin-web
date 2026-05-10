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
from typing import Any, AsyncGenerator, Awaitable, Callable, Dict

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
WEB_ROOT = BASE_DIR.parent
ENV_FILE = BASE_DIR / ".env"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        print(f"Error reading {path}: {error}")
        return

    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")

        if key:
            os.environ.setdefault(key, value)


load_env_file(ENV_FILE)

UNCCOIN_REPO = (WEB_ROOT.parent / "UncCoin").resolve()
UNCCOIN_RUN_SCRIPT = UNCCOIN_REPO / "scripts" / "run.sh"
UNCCOIN_WALLETS_DIR = UNCCOIN_REPO / "state" / "wallets"
BROWSER_WALLETS_FILE = BASE_DIR / "browser_wallets.json"
APP_SETTINGS_FILE = BASE_DIR / "app_settings.json"
REFRESH_SECONDS = 10
NODE_PORT_START = int(os.getenv("UNC_NODE_PORT_START", "8300"))
NODE_PORT_END = int(os.getenv("UNC_NODE_PORT_END", "8500"))
NODE_READY_TIMEOUT_SECONDS = int(os.getenv("UNC_NODE_READY_TIMEOUT_SECONDS", "45"))
SYNC_MAX_WAIT_SECONDS = int(os.getenv("UNC_SYNC_MAX_WAIT_SECONDS", "60"))
DEFAULT_PEER_ADDRESSES = tuple(
    peer_address.strip()
    for peer_address in os.getenv(
        "UNC_PEER_ADDRESSES",
        os.getenv("UNC_PEER_ADDRESS", "100.76.78.49:4040"),
    ).split(",")
    if peer_address.strip()
)
RIGGA_NODE_P2P_PORT = int(os.getenv("UNC_RIGGA_PORT", "4040"))
RIGGA_API_BASE = f"http://127.0.0.1:{RIGGA_NODE_P2P_PORT + 10000}/api/v1"
PASSWORD_ITERATIONS = 240_000


def _find_python_bin() -> str:
    venv_python = UNCCOIN_REPO / ".venv" / "bin" / "python3"
    if venv_python.exists():
        return str(venv_python)
    return "python3"
BONUS_RECEIVER_ADDRESS = "c5c9f38923a71ff93e03317e5afc25e66c786aea8413caea2e48dcc4ae81c7bb"
DEFAULT_BONUS_AMOUNT = "1"
RECENT_WALLET_ACTIVITY_LIMIT = 40
EXTERNAL_API_TOKEN = os.getenv("UNC_WEB_API_TOKEN", "").strip()
BETTING_SHARK_ADDRESS = os.getenv("UNC_BETTING_SHARK_ADDRESS", "").strip()
ADMIN_WALLET_ADDRESSES = {
    addr.strip()
    for addr in os.getenv("UNC_ADMIN_WALLET_ADDRESS", "").split(",")
    if addr.strip()
}
SESSION_TTL_SECONDS = int(os.getenv("UNC_SESSION_TTL_SECONDS", str(24 * 3600)))
LOGIN_RATE_LIMIT_MAX = int(os.getenv("UNC_LOGIN_RATE_LIMIT_MAX", "10"))
LOGIN_RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("UNC_LOGIN_RATE_LIMIT_WINDOW_SECONDS", "60"))
MAX_REQUEST_BODY_BYTES = int(os.getenv("UNC_MAX_REQUEST_BODY_BYTES", str(64 * 1024)))
API_SWEEP_ENABLED = os.getenv("UNC_API_SWEEP_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
API_SWEEP_INTERVAL_SECONDS = int(os.getenv("UNC_API_SWEEP_INTERVAL_SECONDS", "60"))
API_SWEEP_FEE = os.getenv("UNC_API_SWEEP_FEE", "0").strip()
WALLET_WARMUP_ENABLED = os.getenv("UNC_WALLET_WARMUP_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
WALLET_WARMUP_INTERVAL_SECONDS = int(os.getenv("UNC_WALLET_WARMUP_INTERVAL_SECONDS", "300"))
CORS_ALLOWED_ORIGINS = tuple(
    origin.strip()
    for origin in os.getenv("UNC_CORS_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
)

balances: Dict[str, float] = {}
balances_lock = asyncio.Lock()
blockchain: Dict[str, Any] = {}
blockchain_lock = asyncio.Lock()
supply_history_cache: Dict[str, Any] = {}
supply_history_cache_lock = asyncio.Lock()
SUPPLY_HISTORY_CACHE_TTL_SECONDS = 60
browser_wallets: Dict[str, Dict[str, Any]] = {}
browser_wallets_lock = asyncio.Lock()
wallet_sessions: Dict[str, Dict[str, str]] = {}
wallet_sessions_lock = asyncio.Lock()
node_command_lock = asyncio.Lock()
# Maps IP -> list of attempt timestamps for login rate limiting
login_attempts: Dict[str, list] = {}
login_attempts_lock = asyncio.Lock()
refresh_task: asyncio.Task | None = None
api_sweep_task: asyncio.Task | None = None
wallet_warmup_task: asyncio.Task | None = None
wallet_last_warmed: Dict[str, float] = {}
WALLET_NAME_PATTERN = re.compile(r"[^a-z0-9-]+")
UNCCOIN_ADDRESS_PATTERN = re.compile(r"^[0-9a-f]{64}$")
app_settings: Dict[str, str] = {"bonus_amount": DEFAULT_BONUS_AMOUNT}
app_settings_lock = asyncio.Lock()


class WalletLoginRequest(BaseModel):
    wallet_address: str
    password: str


class BrowserWalletCreateRequest(BaseModel):
    wallet_name: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9 _\-]*$")
    password: str = Field(min_length=6, max_length=200)


class BrowserWalletSendRequest(BaseModel):
    receiver_address: str = Field(max_length=64)
    amount: str = Field(max_length=30)
    fee: str = Field(default="0", max_length=30)


class ApiWalletCreateRequest(BaseModel):
    wallet_name: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9 _\-]*$")
    external_user_id: str | None = Field(default=None, max_length=200)


class ApiTransactionRequest(BaseModel):
    sender_address: str
    receiver_address: str
    amount: str
    fee: str = "0"


class BonusAmountUpdateRequest(BaseModel):
    bonus_amount: str


class BrowserWalletRecord(BaseModel):
    wallet_address: str
    wallet_name: str
    created_at: str


class ApiDepositRecord(BaseModel):
    from_address: str
    amount: float
    fee: float
    block_id: int | None
    timestamp: str | None
    nonce: int | None
    transaction_key: str


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


def get_unccoin_wallet_file(wallet_name: str) -> Path:
    return UNCCOIN_WALLETS_DIR / f"{wallet_name}.json"


def load_unccoin_wallet_file(wallet_name: str) -> Dict[str, Any] | None:
    wallet_path = get_unccoin_wallet_file(wallet_name)
    if not wallet_path.exists():
        return None

    try:
        parsed = json.loads(wallet_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    return parsed if isinstance(parsed, dict) else None


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


# Precomputed dummy credential used to equalise timing when a wallet is not found,
# preventing an attacker from learning whether a wallet name/address exists.
_DUMMY_SALT, _DUMMY_HASH = hash_password("dummy-password-for-timing-equalisation")


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


def build_incoming_deposits(wallet_address: str, chain_data: Dict[str, Any]) -> list[Dict[str, Any]]:
    deposits: list[Dict[str, Any]] = []

    for block in chain_data.get("blocks", []):
        if not isinstance(block, dict):
            continue

        block_id = block.get("block_id")
        for transaction_index, transaction in enumerate(block.get("transactions", [])):
            if not isinstance(transaction, dict):
                continue

            sender = str(transaction.get("sender", "")).strip()
            receiver = str(transaction.get("receiver", "")).strip()
            if receiver != wallet_address or sender == "SYSTEM":
                continue

            timestamp = transaction.get("timestamp")
            nonce = transaction.get("nonce")
            transaction_key = ":".join(
                [
                    str(block_id),
                    str(transaction_index),
                    sender,
                    receiver,
                    str(transaction.get("amount", "")),
                    str(nonce),
                ]
            )
            deposits.append(
                ApiDepositRecord(
                    from_address=sender,
                    amount=parse_amount(transaction.get("amount")),
                    fee=parse_amount(transaction.get("fee")),
                    block_id=block_id if isinstance(block_id, int) else None,
                    timestamp=timestamp if isinstance(timestamp, str) else None,
                    nonce=nonce if isinstance(nonce, int) else None,
                    transaction_key=transaction_key,
                ).model_dump()
            )

    deposits.sort(
        key=lambda entry: (
            parse_timestamp(entry.get("timestamp")) or float("-inf"),
            entry.get("block_id") if isinstance(entry.get("block_id"), int) else -1,
        ),
        reverse=True,
    )
    return deposits


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
        if not parsed.is_finite():
            raise InvalidOperation
        if parsed < 0:
            raise HTTPException(status_code=400, detail=f"{field_name} must be zero or greater")
    except HTTPException:
        raise
    except (AttributeError, InvalidOperation) as error:
        raise HTTPException(status_code=400, detail=f"{field_name} must be a valid decimal number") from error

    return parsed


def validate_unccoin_address(address: str, field_name: str = "Receiver address") -> str:
    normalized = address.strip()
    if not UNCCOIN_ADDRESS_PATTERN.match(normalized):
        raise HTTPException(
            status_code=400,
            detail=f"{field_name} must be exactly 64 lowercase hexadecimal characters with no spaces",
        )
    return normalized


def validate_node_command_param(value: str, field_name: str) -> str:
    stripped = value.strip()
    if "\n" in stripped or "\r" in stripped or " " in stripped or "\t" in stripped:
        raise HTTPException(
            status_code=400,
            detail=f"{field_name} contains invalid characters",
        )
    return stripped


def transaction_total(transaction: Dict[str, Any]) -> Decimal:
    try:
        amount = Decimal(str(transaction.get("amount", "0")).strip())
        fee = Decimal(str(transaction.get("fee", "0")).strip())
    except (InvalidOperation, AttributeError):
        return Decimal("0")

    return amount + fee


def get_pending_outgoing_total(chain_data: Dict[str, Any], wallet_address: str) -> Decimal:
    pending_total = Decimal("0")
    pending_transactions = chain_data.get("pending_transactions", [])

    if not isinstance(pending_transactions, list):
        return pending_total

    for transaction in pending_transactions:
        if not isinstance(transaction, dict):
            continue

        if transaction.get("sender") == wallet_address:
            pending_total += transaction_total(transaction)

    return pending_total




async def get_available_wallet_balance(wallet_address: str) -> Decimal:
    balance = await get_wallet_balance(wallet_address)

    async with blockchain_lock:
        chain_data = dict(blockchain)

    confirmed_balance = Decimal(str(balance if balance is not None else 0))
    pending_outgoing = get_pending_outgoing_total(chain_data, wallet_address)
    available_balance = confirmed_balance - pending_outgoing
    return max(available_balance, Decimal("0"))


async def require_available_wallet_balance(wallet_address: str, required_total: Decimal) -> None:
    available_balance = await get_available_wallet_balance(wallet_address)

    if available_balance < required_total:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "insufficient_available_balance",
                "message": (
                    "Insufficient available balance. "
                    f"Needed {required_total}, available {available_balance}. "
                    "Pending outgoing transactions are reserved until they are mined or rejected."
                ),
                "needed": str(required_total),
                "available": str(available_balance),
            },
        )




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
    # Response format: {"tip_hash": ..., "height": N, "balances": [{"address": ..., "alias": ..., "balance": "123.45"}, ...]}
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{RIGGA_API_BASE}/balances", timeout=5.0)
        if resp.status_code != 200:
            return
        data = resp.json()
        if not isinstance(data, dict):
            return
        balance_list = data.get("balances", [])
        if not isinstance(balance_list, list):
            return
        parsed: Dict[str, float] = {}
        for entry in balance_list:
            if not isinstance(entry, dict):
                continue
            addr = str(entry.get("address", "")).strip()
            bal = parse_amount(entry.get("balance", 0))
            if addr and bal > 0:
                parsed[addr] = bal
        # Sort ascending so the frontend's .reverse() shows highest balance first
        sorted_parsed = dict(sorted(parsed.items(), key=lambda x: x[1]))
        async with balances_lock:
            balances.clear()
            balances.update(sorted_parsed)
    except Exception as error:
        print(f"Error loading balances from rigga API: {error}")


async def load_blockchain_once() -> None:
    # /chain/blocks is paginated (from_height, limit max 500). Fetch the most recent 500 blocks.
    try:
        async with httpx.AsyncClient() as client:
            head_resp = await client.get(f"{RIGGA_API_BASE}/chain/head", timeout=5.0)
            from_height = 0
            if head_resp.status_code == 200:
                head = head_resp.json()
                if isinstance(head, dict):
                    h = head.get("height", 0)
                    if isinstance(h, int) and h > 499:
                        from_height = h - 499

            blocks_resp, pending_resp = await asyncio.gather(
                client.get(
                    f"{RIGGA_API_BASE}/chain/blocks",
                    params={"from_height": from_height, "limit": 500},
                    timeout=30.0,
                ),
                client.get(f"{RIGGA_API_BASE}/transactions/pending", timeout=5.0),
                return_exceptions=True,
            )

        chain_data: Dict[str, Any] = {}
        if isinstance(blocks_resp, httpx.Response) and blocks_resp.status_code == 200:
            data = blocks_resp.json()
            if isinstance(data, dict):
                chain_data.update(data)
            elif isinstance(data, list):
                chain_data["blocks"] = data
        if isinstance(pending_resp, httpx.Response) and pending_resp.status_code == 200:
            pending_data = pending_resp.json()
            if isinstance(pending_data, dict):
                chain_data["pending_transactions"] = pending_data.get("transactions", [])
            elif isinstance(pending_data, list):
                chain_data["pending_transactions"] = pending_data
        if not chain_data:
            return
        async with blockchain_lock:
            blockchain.clear()
            blockchain.update(chain_data)
    except Exception as error:
        print(f"Error loading blockchain from rigga API: {error}")




async def refresh_loop() -> None:
    while True:
        await load_balances_once()
        await load_blockchain_once()
        await asyncio.sleep(REFRESH_SECONDS)


async def sweep_api_deposit_wallets_once() -> None:
    if not API_SWEEP_ENABLED or not BETTING_SHARK_ADDRESS:
        return

    await sync_local_exports()
    sweep_fee = parse_decimal_amount(API_SWEEP_FEE, "API sweep fee")

    async with browser_wallets_lock:
        deposit_wallets = [
            dict(record)
            for record in browser_wallets.values()
            if isinstance(record, dict)
            and record.get("wallet_kind") == "api_deposit"
            and str(record.get("wallet_address", "")).strip()
            and str(record.get("wallet_address", "")).strip() != BETTING_SHARK_ADDRESS
        ]

    for wallet_record in deposit_wallets:
        wallet_address = str(wallet_record.get("wallet_address", "")).strip()
        target_address = str(wallet_record.get("sweep_to_address") or BETTING_SHARK_ADDRESS).strip()
        if not wallet_address or not target_address or wallet_address == target_address:
            continue

        available_balance = await get_available_wallet_balance(wallet_address)
        amount_to_sweep = available_balance - sweep_fee
        if amount_to_sweep <= 0:
            continue

        try:
            await send_unccoin_transaction_with_bonus(
                wallet_record=wallet_record,
                receiver_address=target_address,
                amount=str(amount_to_sweep),
                fee=str(sweep_fee),
                bonus_amount="0",
            )
        except HTTPException as error:
            print(f"API deposit sweep failed for {wallet_address}: {error.detail}")
        except Exception as error:
            print(f"API deposit sweep failed for {wallet_address}: {error}")


async def api_sweep_loop() -> None:
    while True:
        try:
            await sweep_api_deposit_wallets_once()
        except Exception as error:
            print(f"API deposit sweep loop failed: {error}")
        await asyncio.sleep(API_SWEEP_INTERVAL_SECONDS)


async def register_browser_wallet(
    wallet_address: str,
    wallet_name: str,
    password: str,
    internal_wallet_name: str,
    wallet_kind: str = "browser",
    external_user_id: str | None = None,
    sweep_to_address: str | None = None,
) -> Dict[str, Any]:
    salt_hex, password_hash = hash_password(password)
    node_port = await allocate_node_port()
    record = {
        "wallet_address": wallet_address,
        "wallet_name": wallet_name,
        "internal_wallet_name": internal_wallet_name,
        "wallet_kind": wallet_kind,
        "node_port": node_port,
        "created_at": now_iso(),
        "password_salt": salt_hex,
        "password_hash": password_hash,
    }
    if external_user_id:
        record["external_user_id"] = external_user_id
    if sweep_to_address:
        record["sweep_to_address"] = sweep_to_address

    async with browser_wallets_lock:
        browser_wallets[wallet_address] = record

    await save_browser_wallets_file()
    return record


async def get_browser_wallet(wallet_address: str) -> Dict[str, Any] | None:
    async with browser_wallets_lock:
        record = browser_wallets.get(wallet_address)
        return dict(record) if record else None


async def update_browser_wallet_internal_name(wallet_address: str, internal_wallet_name: str) -> None:
    updated = False

    async with browser_wallets_lock:
        record = browser_wallets.get(wallet_address)
        if isinstance(record, dict) and record.get("internal_wallet_name") != internal_wallet_name:
            record["internal_wallet_name"] = internal_wallet_name
            updated = True

    if updated:
        await save_browser_wallets_file()


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
        if not session:
            return None
        created_at_str = session.get("created_at", "")
        try:
            created_at = datetime.fromisoformat(created_at_str)
            age = (datetime.now(UTC) - created_at).total_seconds()
            if age > SESSION_TTL_SECONDS:
                wallet_sessions.pop(token, None)
                return None
        except (ValueError, TypeError):
            wallet_sessions.pop(token, None)
            return None
        return session.get("wallet_address")


async def delete_session(token: str) -> None:
    async with wallet_sessions_lock:
        wallet_sessions.pop(token, None)


async def check_login_rate_limit(ip: str) -> None:
    now = asyncio.get_running_loop().time()
    window_start = now - LOGIN_RATE_LIMIT_WINDOW_SECONDS
    async with login_attempts_lock:
        attempts = login_attempts.get(ip, [])
        attempts = [t for t in attempts if t > window_start]
        if len(attempts) >= LOGIN_RATE_LIMIT_MAX:
            login_attempts[ip] = attempts
            raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")
        attempts.append(now)
        login_attempts[ip] = attempts


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


def require_external_api_auth(
    authorization: str | None = None,
    x_api_key: str | None = None,
) -> None:
    if not EXTERNAL_API_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="External API auth is not configured. Set UNC_WEB_API_TOKEN on the backend service.",
        )

    candidate = ""
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer":
            candidate = value.strip()

    if not candidate and x_api_key:
        candidate = x_api_key.strip()

    if not candidate or not secrets.compare_digest(candidate.encode("utf-8"), EXTERNAL_API_TOKEN.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Invalid API token")


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
        print(f"Wallet creation failed (exit {exit_code}):\n{output.strip()}")
        raise HTTPException(status_code=500, detail="Wallet creation failed. Check server logs.")

    wallet_path = get_unccoin_wallet_file(internal_wallet_name)
    saved_path_line = next((line for line in output.splitlines() if line.startswith("Saved to: ")), "")
    address_line = next((line for line in output.splitlines() if line.startswith("Address: ")), "")
    wallet_address = address_line.replace("Address: ", "", 1).strip()
    if not wallet_address:
        print(f"Could not parse wallet address from output:\n{output.strip()}")
        raise HTTPException(status_code=500, detail="Wallet creation failed. Check server logs.")

    if saved_path_line:
        reported_path = Path(saved_path_line.replace("Saved to: ", "", 1).strip())
        if not reported_path.is_absolute():
            reported_path = (UNCCOIN_REPO / reported_path).resolve()

        if reported_path != wallet_path.resolve():
            wallet_path = reported_path

    if not wallet_path.exists():
        raise HTTPException(
            status_code=500,
            detail=(
                "Wallet creation completed without a persisted wallet file. "
                f"Expected wallet at {wallet_path}.\n{output.strip()}"
            ),
        )

    wallet_data = load_unccoin_wallet_file(wallet_path.stem)
    persisted_wallet_address = str((wallet_data or {}).get("address", "")).strip()
    if persisted_wallet_address and persisted_wallet_address != wallet_address:
        raise HTTPException(
            status_code=500,
            detail=(
                "Wallet creation returned an address that does not match the persisted wallet file. "
                f"CLI reported {wallet_address}, but {wallet_path.name} contains {persisted_wallet_address}."
            ),
        )

    return internal_wallet_name, wallet_address


async def resolve_unccoin_wallet_address(wallet_name: str) -> str:
    command = ["python3", "-m", "wallet.cli", "show", "--name", wallet_name]
    exit_code, output = await run_subprocess(command, UNCCOIN_REPO)

    if exit_code != 0:
        print(f"Failed to load local UncCoin wallet '{wallet_name}' (exit {exit_code}):\n{output.strip()}")
        raise HTTPException(status_code=500, detail="Failed to load wallet. Check server logs.")

    address_line = next((line for line in output.splitlines() if line.startswith("Address: ")), "")
    wallet_address = address_line.replace("Address: ", "", 1).strip()
    if not wallet_address:
        print(f"Could not parse wallet address for '{wallet_name}':\n{output.strip()}")
        raise HTTPException(status_code=500, detail="Failed to load wallet. Check server logs.")

    return wallet_address


async def reconcile_browser_wallet_internal_name(wallet_record: Dict[str, Any]) -> str:
    stored_wallet_name = str(wallet_record.get("internal_wallet_name", "")).strip()
    expected_wallet_address = str(wallet_record.get("wallet_address", "")).strip()
    display_wallet_name = str(wallet_record.get("wallet_name", "")).strip()
    candidate_names: list[str] = []

    def add_candidate(name: str) -> None:
        normalized = name.strip()
        if normalized and normalized not in candidate_names:
            candidate_names.append(normalized)

    add_candidate(stored_wallet_name)
    add_candidate(display_wallet_name)

    sanitized_label = sanitize_wallet_label(display_wallet_name)
    add_candidate(sanitized_label)
    add_candidate(f"browser-{sanitized_label}")

    for candidate in candidate_names:
        wallet_data = load_unccoin_wallet_file(candidate)
        if not wallet_data:
            continue

        candidate_address = str(wallet_data.get("address", "")).strip()
        if expected_wallet_address and candidate_address == expected_wallet_address:
            if candidate != stored_wallet_name:
                await update_browser_wallet_internal_name(expected_wallet_address, candidate)
                wallet_record["internal_wallet_name"] = candidate
            return candidate

    if UNCCOIN_WALLETS_DIR.exists():
        prefix = f"browser-{sanitized_label}-"

        for wallet_path in sorted(UNCCOIN_WALLETS_DIR.glob("*.json")):
            wallet_data = load_unccoin_wallet_file(wallet_path.stem)
            if not wallet_data:
                continue

            candidate_name = str(wallet_data.get("name", wallet_path.stem)).strip() or wallet_path.stem
            candidate_address = str(wallet_data.get("address", "")).strip()

            if expected_wallet_address and candidate_address == expected_wallet_address:
                if candidate_name != stored_wallet_name:
                    await update_browser_wallet_internal_name(expected_wallet_address, candidate_name)
                    wallet_record["internal_wallet_name"] = candidate_name
                return candidate_name

            if candidate_name.startswith(prefix):
                if candidate_name != stored_wallet_name:
                    await update_browser_wallet_internal_name(expected_wallet_address, candidate_name)
                    wallet_record["internal_wallet_name"] = candidate_name
                return candidate_name

    missing_name = stored_wallet_name or display_wallet_name or expected_wallet_address or "unknown"
    raise HTTPException(
        status_code=500,
        detail=(
            "Failed to locate the local UncCoin wallet file for this browser wallet. "
            f"Tried: {', '.join(candidate_names) if candidate_names else missing_name}"
        ),
    )


async def verify_wallet_record_identity(wallet_record: Dict[str, Any]) -> None:
    resolved_wallet_name = await reconcile_browser_wallet_internal_name(wallet_record)
    local_wallet_address = await resolve_unccoin_wallet_address(resolved_wallet_name)
    expected_wallet_address = wallet_record["wallet_address"]

    if local_wallet_address != expected_wallet_address:
        raise HTTPException(
            status_code=409,
            detail=(
                "Local wallet mapping mismatch. "
                f"Stored browser wallet address is {expected_wallet_address}, "
                f"but local UncCoin wallet '{resolved_wallet_name}' resolves to {local_wallet_address}."
            ),
        )


class NodeApiRunner:
    """Manages an ephemeral UncCoin wallet node and communicates with it via HTTP API."""

    def __init__(self, wallet_name: str, node_port: int):
        self.wallet_name = wallet_name
        self.node_port = node_port
        self.api_base = f"http://127.0.0.1:{node_port + 10000}/api/v1"
        self.process: asyncio.subprocess.Process | None = None
        self.output_lines: deque[str] = deque(maxlen=200)
        self._stream_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        # Use run.sh so the correct Python/venv is found the same way as manual usage.
        # stdin=PIPE keeps the interactive console alive (DEVNULL would cause immediate EOF→exit).
        # run.sh auto-sets --api-port as node_port+10000 and passes extra args as --peer.
        cmd = [str(UNCCOIN_RUN_SCRIPT), self.wallet_name, str(self.node_port)] + list(DEFAULT_PEER_ADDRESSES)
        self.process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(UNCCOIN_REPO),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self._stream_task = asyncio.create_task(self._stream_output())

    async def _stream_output(self) -> None:
        if self.process is None or self.process.stdout is None:
            return
        while True:
            line = await self.process.stdout.readline()
            if not line:
                break
            self.output_lines.append(line.decode("utf-8", errors="replace").rstrip())

    async def wait_until_ready(self) -> None:
        deadline = asyncio.get_running_loop().time() + NODE_READY_TIMEOUT_SECONDS
        async with httpx.AsyncClient() as client:
            while asyncio.get_running_loop().time() < deadline:
                if self.process is not None and self.process.returncode is not None:
                    raise HTTPException(status_code=500, detail="Node exited unexpectedly during startup.")
                try:
                    resp = await client.get(f"{self.api_base}/health", timeout=2.0)
                    if resp.status_code == 200:
                        data = resp.json()
                        peers = data.get("peers", {})
                        if isinstance(peers, dict) and peers.get("connected", 0) >= 1:
                            return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.5)
        raise HTTPException(status_code=504, detail="Timed out waiting for node startup and peer connection.")

    async def sync(self) -> None:
        deadline = asyncio.get_running_loop().time() + SYNC_MAX_WAIT_SECONDS
        async with httpx.AsyncClient() as client:
            try:
                await client.post(f"{self.api_base}/control/sync", json={"fast": True}, timeout=5.0)
            except httpx.HTTPError as error:
                raise HTTPException(status_code=503, detail=f"Sync request failed: {error}")
            while asyncio.get_running_loop().time() < deadline:
                if self.process is not None and self.process.returncode is not None:
                    raise HTTPException(status_code=500, detail="Node exited unexpectedly during sync.")
                try:
                    resp = await client.get(f"{self.api_base}/sync/status", timeout=5.0)
                    if resp.status_code == 200 and resp.json().get("phase") == "ready":
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(1.0)
        raise HTTPException(status_code=504, detail="Timed out waiting for blockchain sync.")

    async def get_balance(self, address: str) -> Decimal:
        # Response: {"address": ..., "balance": "123.45", "tip_hash": ..., "height": ...}
        async with httpx.AsyncClient() as client:
            try:
                resp = await client.get(f"{self.api_base}/balances/{address}", timeout=5.0)
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, dict):
                        return Decimal(str(data.get("balance", "0")))
            except (httpx.HTTPError, InvalidOperation):
                pass
        return Decimal("0")

    async def send_transaction(self, receiver: str, amount: str, fee: str) -> str:
        safe_receiver = validate_unccoin_address(receiver, "Receiver address")
        async with httpx.AsyncClient() as client:
            try:
                resp = await client.post(
                    f"{self.api_base}/control/transactions",
                    json={"receiver": safe_receiver, "amount": amount.strip(), "fee": fee.strip()},
                    timeout=30.0,
                )
            except httpx.HTTPError as error:
                raise HTTPException(status_code=503, detail=f"Transaction request failed: {error}")
            if resp.status_code != 200:
                body = resp.json() if "application/json" in resp.headers.get("content-type", "") else {}
                raise HTTPException(status_code=400, detail=f"Transaction rejected: {body.get('detail', resp.text)}")
            return str(resp.json().get("transaction_id", ""))

    def check_for_peer_rejection(self, since_index: int) -> None:
        for line in reversed(list(self.output_lines)[since_index:]):
            if "nonce does not match" in line or (
                "Rejected transaction" in line and "Rejected local transaction" not in line
            ):
                raise HTTPException(status_code=409, detail=f"Transaction rejected by network: {line.strip()}")

    async def close(self) -> None:
        if self.process is None:
            return
        if self.process.returncode is None:
            try:
                if self.process.stdin:
                    self.process.stdin.write(b"quit\n")
                    await self.process.stdin.drain()
                    self.process.stdin.close()
                await asyncio.wait_for(self.process.wait(), timeout=10)
            except Exception:
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=5)
                except Exception:
                    self.process.kill()
                    await self.process.wait()
        if self._stream_task is not None:
            try:
                await asyncio.wait_for(self._stream_task, timeout=5)
            except Exception:
                pass


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


async def warm_wallet_node(wallet_record: Dict[str, Any]) -> None:
    wallet_address = str(wallet_record["wallet_address"]).strip()
    node_port = int(wallet_record["node_port"])
    runner = NodeApiRunner(str(wallet_record["internal_wallet_name"]).strip(), node_port)
    try:
        await runner.start()
        await runner.wait_until_ready()
        await runner.sync()
        wallet_last_warmed[wallet_address] = asyncio.get_running_loop().time()
        print(f"Warmup: synced wallet {wallet_address[:16]}...")
    except Exception as error:
        print(f"Warmup: failed for wallet {wallet_address[:16]}: {error}")
    finally:
        await runner.close()


async def wallet_warmup_loop() -> None:
    while True:
        async with browser_wallets_lock:
            candidates = [
                dict(record)
                for record in browser_wallets.values()
                if isinstance(record, dict) and str(record.get("wallet_address", "")).strip()
            ]

        # Spread warmups evenly so every wallet is hit within the target interval.
        # E.g. 100 wallets, 300s target → sleep 3s between each warmup.
        sleep_seconds = max(1.0, WALLET_WARMUP_INTERVAL_SECONDS / max(len(candidates), 1))
        await asyncio.sleep(sleep_seconds)

        if not candidates or node_command_lock.locked():
            continue

        now = asyncio.get_running_loop().time()
        target = min(candidates, key=lambda w: wallet_last_warmed.get(str(w["wallet_address"]).strip(), 0))
        last_warmed = wallet_last_warmed.get(str(target["wallet_address"]).strip(), 0)
        if now - last_warmed < WALLET_WARMUP_INTERVAL_SECONDS:
            continue

        async with node_command_lock:
            await warm_wallet_node(target)


async def send_unccoin_transaction_with_bonus(
    wallet_record: Dict[str, Any],
    receiver_address: str,
    amount: str,
    fee: str,
    bonus_amount: str,
    on_broadcast: Callable[[], Awaitable[None]] | None = None,
) -> str:
    if not receiver_address.strip():
        raise HTTPException(status_code=400, detail="Receiver wallet address is required")

    validate_unccoin_address(receiver_address, "Receiver address")

    primary_amount = parse_decimal_amount(amount, "Amount")
    primary_fee = parse_decimal_amount(fee, "Fee")
    bonus_decimal = parse_decimal_amount(bonus_amount, "Bonus amount")
    required_total = primary_amount + primary_fee + bonus_decimal
    wallet_address = str(wallet_record["wallet_address"]).strip()

    async with node_command_lock:
        await load_balances_once()
        await require_available_wallet_balance(wallet_address, required_total)
        await verify_wallet_record_identity(wallet_record)

        node_port = int(wallet_record["node_port"])
        runner = NodeApiRunner(str(wallet_record["internal_wallet_name"]).strip(), node_port)
        try:
            await runner.start()
            await runner.wait_until_ready()
            await runner.sync()
            wallet_last_warmed[wallet_address] = asyncio.get_running_loop().time()

            node_balance = await runner.get_balance(wallet_address)
            if node_balance < required_total:
                raise HTTPException(
                    status_code=402,
                    detail=f"Insufficient balance after sync. Available: {node_balance}, required: {required_total}",
                )

            pre_tx_index = len(runner.output_lines)
            tx_id = await runner.send_transaction(receiver_address, amount, fee)
            if on_broadcast:
                await on_broadcast()

            # Brief wait for peer rejection propagation (e.g. nonce mismatch from a forked peer)
            await asyncio.sleep(3)
            runner.check_for_peer_rejection(pre_tx_index)

            if bonus_decimal > 0:
                try:
                    bonus_index = len(runner.output_lines)
                    await runner.send_transaction(BONUS_RECEIVER_ADDRESS, str(bonus_decimal), "0")
                    await asyncio.sleep(1)
                    runner.check_for_peer_rejection(bonus_index)
                except HTTPException as bonus_error:
                    print(f"Bonus tx failed after main tx (sender {wallet_address}): {bonus_error.detail}")

            await sync_local_exports()
            return tx_id
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(status_code=500, detail=f"Failed to send transaction: {error}") from error
        finally:
            await runner.close()


async def _prewarm_supply_history_cache() -> None:
    for max_points in (180, 60):
        try:
            await get_supply_history(max_points)
        except Exception as error:
            print(f"Supply history prewarm failed for max_points={max_points}: {error}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global refresh_task, api_sweep_task

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
    asyncio.create_task(_prewarm_supply_history_cache())
    refresh_task = asyncio.create_task(refresh_loop())
    if API_SWEEP_ENABLED and BETTING_SHARK_ADDRESS:
        api_sweep_task = asyncio.create_task(api_sweep_loop())
    if WALLET_WARMUP_ENABLED:
        wallet_warmup_task = asyncio.create_task(wallet_warmup_loop())

    try:
        yield
    finally:
        if refresh_task:
            refresh_task.cancel()
            try:
                await refresh_task
            except asyncio.CancelledError:
                pass
        if api_sweep_task:
            api_sweep_task.cancel()
            try:
                await api_sweep_task
            except asyncio.CancelledError:
                pass
        if wallet_warmup_task:
            wallet_warmup_task.cancel()
            try:
                await wallet_warmup_task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Wallet Balances API", lifespan=lifespan)


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > MAX_REQUEST_BODY_BYTES:
            return Response("Request body too large", status_code=413)
        return await call_next(request)


app.add_middleware(RequestSizeLimitMiddleware)

if CORS_ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(CORS_ALLOWED_ORIGINS),
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-API-Key"],
    )


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
async def wallet_login(payload: WalletLoginRequest, request: Request) -> BrowserWalletSessionResponse:
    client_ip = request.client.host if request.client else "unknown"
    await check_login_rate_limit(client_ip)

    login_identifier = payload.wallet_address.strip()
    if not login_identifier:
        raise HTTPException(status_code=400, detail="Wallet name or address is required")

    wallet_record = await find_browser_wallet_by_login(login_identifier)

    # Always run verify_password to equalise timing regardless of whether the
    # wallet exists, preventing enumeration of valid wallet names via response time.
    salt = wallet_record["password_salt"] if wallet_record else _DUMMY_SALT
    pw_hash = wallet_record["password_hash"] if wallet_record else _DUMMY_HASH
    password_ok = verify_password(payload.password, salt, pw_hash)

    if not wallet_record or not password_ok:
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
    await send_unccoin_transaction_with_bonus(
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
        "bonus_amount": bonus_amount,
    }


@app.post("/wallet-send-stream")
async def wallet_send_stream(
    payload: BrowserWalletSendRequest,
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    wallet_record = await require_authenticated_browser_wallet(authorization)
    bonus_amount = await get_bonus_amount_setting()
    event_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()

    async def on_broadcast() -> None:
        await event_queue.put({"status": "broadcast"})

    async def run() -> None:
        try:
            await send_unccoin_transaction_with_bonus(
                wallet_record=wallet_record,
                receiver_address=payload.receiver_address,
                amount=payload.amount,
                fee=payload.fee,
                bonus_amount=bonus_amount,
                on_broadcast=on_broadcast,
            )
            wallet = await get_wallet_summary(
                wallet_record["wallet_address"],
                require_chain_presence=False,
                activity_limit=RECENT_WALLET_ACTIVITY_LIMIT,
            )
            await event_queue.put({
                "status": "done",
                "wallet": wallet,
                "browser_wallet": format_browser_wallet_record(wallet_record),
            })
        except HTTPException as exc:
            await event_queue.put({"status": "error", "code": exc.status_code, "detail": exc.detail})
        except Exception as exc:
            await event_queue.put({"status": "error", "code": 500, "detail": str(exc)})

    async def generate() -> AsyncGenerator[str, None]:
        task = asyncio.create_task(run())
        try:
            while True:
                event = await event_queue.get()
                yield f"data: {json.dumps(event)}\n\n"
                if event["status"] in ("done", "error"):
                    break
        finally:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/wallets")
@app.post("/api/wallets")
async def api_create_wallet(
    payload: ApiWalletCreateRequest,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> Dict[str, Any]:
    require_external_api_auth(authorization, x_api_key)
    internal_wallet_name, wallet_address = await create_unccoin_wallet(payload.wallet_name)
    wallet_record = await register_browser_wallet(
        wallet_address=wallet_address,
        wallet_name=payload.wallet_name.strip(),
        password=secrets.token_urlsafe(32),
        internal_wallet_name=internal_wallet_name,
        wallet_kind="api_deposit",
        external_user_id=payload.external_user_id.strip() if payload.external_user_id else None,
        sweep_to_address=BETTING_SHARK_ADDRESS or None,
    )
    summary = await get_wallet_summary(
        wallet_address,
        require_chain_presence=False,
        activity_limit=RECENT_WALLET_ACTIVITY_LIMIT,
    )
    return {
        "ok": True,
        "wallet": format_browser_wallet_record(wallet_record),
        "summary": summary,
    }


@app.post("/transactions")
@app.post("/api/transactions")
async def api_send_transaction(
    payload: ApiTransactionRequest,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> Dict[str, Any]:
    require_external_api_auth(authorization, x_api_key)
    sender_address = payload.sender_address.strip()
    if not BETTING_SHARK_ADDRESS:
        raise HTTPException(status_code=503, detail="UNC_BETTING_SHARK_ADDRESS is not configured")
    if sender_address != BETTING_SHARK_ADDRESS:
        raise HTTPException(status_code=403, detail="External withdrawals can only be sent from UNC_BETTING_SHARK_ADDRESS")

    wallet_record = await get_browser_wallet(sender_address)
    if not wallet_record:
        raise HTTPException(status_code=404, detail="Sender wallet is not managed by this backend")

    tx_id = await send_unccoin_transaction_with_bonus(
        wallet_record=wallet_record,
        receiver_address=payload.receiver_address,
        amount=payload.amount,
        fee="0",
        bonus_amount="0",
    )
    wallet = await get_wallet_summary(
        sender_address,
        require_chain_presence=False,
        activity_limit=RECENT_WALLET_ACTIVITY_LIMIT,
    )
    return {
        "ok": True,
        "status": "submitted",
        "message": "Withdrawal transaction was broadcast. It is not final until mined into a block.",
        "transaction": {
            "sender_address": sender_address,
            "receiver_address": payload.receiver_address.strip(),
            "amount": payload.amount.strip(),
            "fee": "0",
            "transaction_id": tx_id,
        },
        "wallet": wallet,
    }


@app.get("/api/blockchain")
async def api_get_blockchain(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> Dict[str, Any]:
    require_external_api_auth(authorization, x_api_key)
    return await get_blockchain()


@app.get("/api/balances")
async def api_get_balances(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> Dict[str, float]:
    require_external_api_auth(authorization, x_api_key)
    return await get_balances()


@app.get("/api/wallets/{wallet_address}")
async def api_get_wallet(
    wallet_address: str,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> Dict[str, Any]:
    require_external_api_auth(authorization, x_api_key)
    return await get_wallet_summary(wallet_address)


@app.get("/wallets/{wallet_address}/incoming")
@app.get("/api/wallets/{wallet_address}/incoming")
async def api_get_wallet_incoming(
    wallet_address: str,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> Dict[str, Any]:
    require_external_api_auth(authorization, x_api_key)
    async with blockchain_lock:
        chain_data = dict(blockchain)

    return {
        "ok": True,
        "wallet_address": wallet_address,
        "incoming": build_incoming_deposits(wallet_address, chain_data),
    }


@app.post("/sweep")
@app.post("/api/sweep")
async def api_sweep_deposit_wallets(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> Dict[str, Any]:
    require_external_api_auth(authorization, x_api_key)
    if not BETTING_SHARK_ADDRESS:
        raise HTTPException(status_code=503, detail="UNC_BETTING_SHARK_ADDRESS is not configured")

    await sweep_api_deposit_wallets_once()
    return {"ok": True}


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
    wallet_record = await require_authenticated_browser_wallet(authorization)
    if not ADMIN_WALLET_ADDRESSES or wallet_record.get("wallet_address", "") not in ADMIN_WALLET_ADDRESSES:
        raise HTTPException(status_code=403, detail="Not authorized to update bonus amount")
    bonus_amount = await set_bonus_amount_setting(payload.bonus_amount)
    return {
        "ok": True,
        "bonus_amount": bonus_amount,
    }


@app.get("/wallets/{wallet_address}")
async def get_wallet(wallet_address: str) -> Dict[str, Any]:
    return await get_wallet_summary(wallet_address)


async def _compute_supply_history(max_points: int) -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient() as client:
            head_resp = await client.get(f"{RIGGA_API_BASE}/chain/head", timeout=5.0)
        if head_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch chain head")
        head = head_resp.json()
        total_height = head.get("height", 0) if isinstance(head, dict) else 0
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Failed to fetch chain head: {error}")

    all_blocks: list[Dict[str, Any]] = []
    batch_size = 500
    from_height = 0

    async with httpx.AsyncClient() as client:
        while True:
            try:
                resp = await client.get(
                    f"{RIGGA_API_BASE}/chain/blocks",
                    params={"from_height": from_height, "limit": batch_size},
                    timeout=30.0,
                )
            except httpx.HTTPError as error:
                raise HTTPException(status_code=502, detail=f"Failed to fetch blocks at height {from_height}: {error}")

            if resp.status_code != 200:
                break

            data = resp.json()
            if isinstance(data, dict):
                blocks = data.get("blocks", [])
            elif isinstance(data, list):
                blocks = data
            else:
                blocks = []

            if not isinstance(blocks, list) or not blocks:
                break

            all_blocks.extend(blocks)
            from_height += len(blocks)

            if len(blocks) < batch_size:
                break

    supply = 0.0
    supply_series: list[Dict[str, Any]] = []

    for block in all_blocks:
        block_timestamp: str | None = None
        for transaction in block.get("transactions", []):
            if not block_timestamp:
                ts = transaction.get("timestamp")
                if isinstance(ts, str) and ts.strip():
                    block_timestamp = ts.strip()

            sender = str(transaction.get("sender", ""))
            receiver = str(transaction.get("receiver", ""))
            amount = parse_amount(transaction.get("amount", 0))

            if sender == "SYSTEM":
                supply += amount
            if receiver == "SYSTEM":
                supply -= amount

        if block_timestamp:
            supply_series.append({
                "timestamp": block_timestamp,
                "supply": supply,
                "block_id": block.get("block_id"),
            })

    full_result = {
        "supply_series": supply_series,
        "total_height": total_height,
        "total_blocks_processed": len(all_blocks),
    }

    if len(supply_series) > max_points:
        last_index = len(supply_series) - 1
        sampled: list[Dict[str, Any]] = []
        for i in range(max_points):
            source_index = last_index if i == max_points - 1 else round((i / (max_points - 1)) * last_index)
            point = supply_series[source_index]
            if sampled and sampled[-1]["block_id"] == point["block_id"]:
                sampled[-1] = point
            else:
                sampled.append(point)
        full_result["supply_series"] = sampled

    return full_result


@app.get("/supply-history")
async def get_supply_history(max_points: int = 500) -> Dict[str, Any]:
    max_points = min(max(max_points, 10), 2000)
    import time

    cache_key = str(max_points)
    async with supply_history_cache_lock:
        cached = supply_history_cache.get(cache_key)
        if cached and time.monotonic() - cached["cached_at"] < SUPPLY_HISTORY_CACHE_TTL_SECONDS:
            return cached["data"]

    result = await _compute_supply_history(max_points)

    async with supply_history_cache_lock:
        supply_history_cache[cache_key] = {"data": result, "cached_at": time.monotonic()}

    return result


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}
