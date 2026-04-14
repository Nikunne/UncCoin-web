const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export type WalletActivityItem = {
    block_id: number | null;
    kind: "sent" | "received" | "mined";
    sender: string;
    receiver: string;
    amount: number;
    fee: number;
    timestamp: string | null;
};

export type WalletSummary = {
    wallet_address: string;
    balance: number;
    transaction_count: number;
    sent_count: number;
    received_count: number;
    total_sent: number;
    total_received: number;
    total_fees_paid: number;
    mined_block_count: number;
    block_appearance_count: number;
    latest_activity: string | null;
    activity: WalletActivityItem[];
};

type WalletLoginResponse = {
    ok: boolean;
    wallet: WalletSummary;
};

export async function loginWithWallet(walletAddress: string, password: string): Promise<WalletSummary> {
    const response = await fetch(`${API_BASE_URL}/wallet-login`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            wallet_address: walletAddress,
            password,
        }),
    });

    if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? `Failed to log in: ${response.status}`);
    }

    const data = (await response.json()) as WalletLoginResponse;
    return data.wallet;
}

export async function getWalletSummary(walletAddress: string): Promise<WalletSummary> {
    const response = await fetch(`${API_BASE_URL}/wallets/${encodeURIComponent(walletAddress)}`);

    if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? `Failed to fetch wallet: ${response.status}`);
    }

    return (await response.json()) as WalletSummary;
}
