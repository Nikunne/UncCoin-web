const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export type BalanceRow = [string, number];

export async function getBalances(): Promise<BalanceRow[]> {
    const response = await fetch(`${API_BASE_URL}/balances`);

    if (!response.ok) {
        throw new Error(`Failed to fetch balances: ${response.status}`);
    }

    return response.json();
}