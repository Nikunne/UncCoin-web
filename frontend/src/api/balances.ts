const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export type BalanceRow = [string, number];

export async function getBalances(): Promise<BalanceRow[]> {
    const response = await fetch(`${API_BASE_URL}/balances`);

    if (!response.ok) {
        throw new Error(`Failed to fetch balances: ${response.status}`);
    }

    const data = (await response.json()) as Record<string, number>;
    return Object.entries(data);
}