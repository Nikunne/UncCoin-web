const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export type BlockchainTransaction = {
    sender: string;
    receiver: string;
    amount: string;
    fee: string;
    timestamp: string;
    nonce: number;
    sender_public_key: string | null;
    signature: string | null;
};

export type BlockchainBlock = {
    block_id: number;
    transactions: BlockchainTransaction[];
    description: string;
    previous_hash: string;
    nonce: number;
    block_hash: string;
};

export type BlockchainResponse = {
    wallet_address: string;
    wallet_names?: Record<string, string>;
    difficulty_bits: number;
    genesis_difficulty_bits: number;
    difficulty_growth_factor: number;
    difficulty_growth_start_height: number;
    difficulty_growth_bits: number;
    difficulty_schedule_activation_height: number;
    pending_transactions?: BlockchainTransaction[];
    blocks: BlockchainBlock[];
};

export async function getBlockchain(): Promise<BlockchainResponse> {
    const response = await fetch(`${API_BASE_URL}/blockchain`);

    if (!response.ok) {
        throw new Error(`Failed to fetch blockchain: ${response.status}`);
    }

    return (await response.json()) as BlockchainResponse;
}
