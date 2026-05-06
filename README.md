# UncCoin Web

FastAPI backend and React frontend for reading UncCoin balances/blockchain data, creating wallets, and sending UncCoins through the local UncCoin repo.

## Production Config

The backend reads `backend/.env` on startup. Keep this file out of git.

Start from the example:

```bash
cp backend/.env.example backend/.env
```

Required for the external API:

```bash
UNC_WEB_API_TOKEN=change-this-long-random-secret
UNC_BETTING_SHARK_ADDRESS=put-betting-shark-house-wallet-address-here
```

Useful defaults:

```bash
UNC_API_SWEEP_ENABLED=true
UNC_API_SWEEP_INTERVAL_SECONDS=60
UNC_API_SWEEP_FEE=0
UNC_PEER_ADDRESSES=100.76.78.49:4040,100.71.105.5:4000
```

`UNC_WEB_API_TOKEN` is the shared secret used by the other site's server. Never expose it in browser code.

`UNC_BETTING_SHARK_ADDRESS` is the house wallet address that API-created deposit wallets sweep their UncCoins into.

Create the house wallet once, then put its address in `UNC_BETTING_SHARK_ADDRESS`. You can create it with the browser wallet UI, the UncCoin CLI, or temporarily with `POST /api/wallets` before setting the env value. Once `UNC_BETTING_SHARK_ADDRESS` is set, external withdrawal calls are only allowed from that address.

## External API Flow

The other site should not need to understand the blockchain.

1. When a user account is created on the other site, call `POST /api/wallets`.
2. Store the returned `wallet.wallet_address` on that user profile as the user's UncCoin deposit address.
3. When that deposit wallet receives UncCoins, UncCoin-web detects the available balance and automatically sends it to `UNC_BETTING_SHARK_ADDRESS`.
4. The other site calls `GET /api/wallets/{wallet_address}/incoming` for its known deposit wallets and credits its own internal coins for new transactions it has not processed before.
5. For withdrawals, the other site calls `POST /api/transactions` from the house wallet to the user's requested UncCoin address.

External wallet creation, withdrawal, incoming-deposit, and sweep endpoints require one of:

```http
Authorization: Bearer <UNC_WEB_API_TOKEN>
X-API-Key: <UNC_WEB_API_TOKEN>
```

## Create A Deposit Wallet

```bash
curl -X POST https://your-domain/api/wallets \
  -H "Authorization: Bearer $UNC_WEB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet_name": "betting-shark-user-123",
    "external_user_id": "123"
  }'
```

Response shape:

```json
{
  "ok": true,
  "wallet": {
    "wallet_address": "deposit-wallet-address",
    "wallet_name": "betting-shark-user-123",
    "created_at": "2026-05-06T12:00:00+00:00"
  },
  "summary": {
    "wallet_address": "deposit-wallet-address",
    "balance": 0
  }
}
```

The `wallet_name` is a friendly API/web label. Transactions use wallet addresses.

## Read Deposits For A User Wallet

```bash
curl https://your-domain/api/wallets/deposit-wallet-address/incoming \
  -H "Authorization: Bearer $UNC_WEB_API_TOKEN"
```

Response shape:

```json
{
  "ok": true,
  "wallet_address": "deposit-wallet-address",
  "incoming": [
    {
      "from_address": "sender-address",
      "amount": 100,
      "fee": 0,
      "block_id": 123,
      "timestamp": "2026-05-06T12:34:56+00:00",
      "nonce": 4,
      "transaction_key": "123:0:sender-address:deposit-wallet-address:100:4"
    }
  ]
}
```

The other site should store processed `transaction_key` values so it never credits the same deposit twice.

## Withdraw From House Wallet

Use this when a user wants to withdraw the other site's internal coins as UncCoins.

```bash
curl -X POST https://your-domain/api/transactions \
  -H "Authorization: Bearer $UNC_WEB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sender_address": "betting-shark-house-wallet-address",
    "receiver_address": "user-withdrawal-wallet-address",
    "amount": "250",
    "fee": "0"
  }'
```

The backend rejects this call unless `sender_address` exactly matches `UNC_BETTING_SHARK_ADDRESS`. It also rejects sends when confirmed balance minus pending outgoing transactions is too low.

If the house wallet does not have enough available UncCoins, the API returns HTTP `409`:

```json
{
  "detail": {
    "code": "insufficient_available_balance",
    "message": "Insufficient available balance. Needed 250, available 100. Pending outgoing transactions are reserved until they are mined or rejected.",
    "needed": "250",
    "available": "100"
  }
}
```

## Manual Sweep

Automatic sweeping runs in the backend when `UNC_API_SWEEP_ENABLED=true` and `UNC_BETTING_SHARK_ADDRESS` is set. To trigger a sweep manually:

```bash
curl -X POST https://your-domain/api/sweep \
  -H "Authorization: Bearer $UNC_WEB_API_TOKEN"
```

## Read Chain Data

```bash
curl https://your-domain/api/blockchain \
  -H "Authorization: Bearer $UNC_WEB_API_TOKEN"

curl https://your-domain/api/balances \
  -H "Authorization: Bearer $UNC_WEB_API_TOKEN"

curl https://your-domain/api/wallets/wallet-address \
  -H "Authorization: Bearer $UNC_WEB_API_TOKEN"
```

## Local Commands

Frontend build:

```bash
cd frontend
npm run build
```

Backend:

```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000
```
