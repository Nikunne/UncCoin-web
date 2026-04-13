import { useEffect, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { getBalances, type BalanceRow } from "./api/balances";
import { getBlockchain, type BlockchainBlock, type BlockchainResponse } from "./api/blockchain";
import "./App.css";

const INITIAL_BLOCKS_VISIBLE = 25;
const BLOCKS_PER_BATCH = 25;

function formatTimestamp(timestamp: string): string {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
        return timestamp;
    }

    return parsed.toLocaleString();
}

function truncateHash(hash: string): string {
    if (hash.length <= 20) {
        return hash;
    }

    return `${hash.slice(0, 10)}...${hash.slice(-10)}`;
}

function HomePage() {
    const [balances, setBalances] = useState<BalanceRow[]>([]);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const totalUncCoins = balances.reduce((sum, [, amount]) => sum + amount, 0);

    useEffect(() => {
        let active = true;

        const load = async () => {
            try {
                const data = await getBalances();
                if (active) {
                    setBalances(data);
                    setLastUpdated(new Date());
                }
            } catch (error) {
                console.error(error);
            }
        };

        load();
        const fetchTimer = setInterval(load, 60_000);
        const reloadTimer = setInterval(() => {
            window.location.reload();
        }, 60_000);

        return () => {
            active = false;
            clearInterval(fetchTimer);
            clearInterval(reloadTimer);
        };
    }, []);

    return (
        <div className="balances-page">
            <header className="masthead">
                <h1 className="balances-title">UncCoin</h1>
                <p className="masthead-subtitle">The most genuine cryptocurrency ever*</p>
            </header>

            <div className="page-actions">
                <div className="investment-cta">
                    <a
                        className="investment-link"
                        href="https://en.wikipedia.org/wiki/Exit_scam#Cryptocurrency_scams"
                        target="_blank"
                        rel="noreferrer"
                    >
                        Interested in investing? Click-here!
                    </a>
                </div>
                <div className="investment-cta">
                    <Link className="investment-link" to="/blockchain">
                        View blockchain
                    </Link>
                </div>
            </div>

            <section className="balances-shell" aria-label="UncCoin balances">
                <div className="balances-meta">
                    <span className="balances-section-title">Balance Sheet</span>
                    <p className="total-unc-coins">Total UncCoins: {totalUncCoins}</p>
                </div>

                <div className="balances-submeta">
                    <div className="repo-notes" aria-label="Project notes">
                        <a
                            className="repo-link"
                            href="https://github.com/Fleli/UncCoin"
                            target="_blank"
                            rel="noreferrer"
                        >
                            Github-link for UncCoin
                        </a>
                        <a
                            className="repo-link"
                            href="https://github.com/Nikunne/UncCoin-web"
                            target="_blank"
                            rel="noreferrer"
                        >
                            Github-link for UncCoin-web
                        </a>
                    </div>
                    <p className="last-updated">
                        Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "loading..."}
                    </p>
                </div>

                <div className="balances-card">
                    {[...balances].reverse().map(([user, amount]) => (
                        <div key={user} className="balance-row">
                            <span className="balance-user">{user}</span>
                            <span className="balance-amount">{amount}</span>
                        </div>
                    ))}
                </div>
                <p>*Heard at Sit Hangaren, April 2026</p>
            </section>
        </div>
    );
}

function BlockchainPage() {
    const [blockchain, setBlockchain] = useState<BlockchainResponse | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [visibleBlocks, setVisibleBlocks] = useState(INITIAL_BLOCKS_VISIBLE);
    const [selectedAddress, setSelectedAddress] = useState("");
    const [showScrollTop, setShowScrollTop] = useState(false);
    const [scrollToBottomRequested, setScrollToBottomRequested] = useState(false);

    useEffect(() => {
        let active = true;

        const load = async () => {
            try {
                const data = await getBlockchain();
                if (active) {
                    setBlockchain(data);
                    setLastUpdated(new Date());
                }
            } catch (error) {
                console.error(error);
            }
        };

        load();
        const fetchTimer = setInterval(load, 10_000);

        return () => {
            active = false;
            clearInterval(fetchTimer);
        };
    }, []);

    const blocks: BlockchainBlock[] = blockchain?.blocks ?? [];
    const addresses = Array.from(
        new Set(
            blocks.flatMap((block) =>
                block.transactions.flatMap((transaction) => [transaction.sender, transaction.receiver]),
            ),
        ),
    ).sort((left, right) => left.localeCompare(right));
    const filteredBlocks = selectedAddress
        ? blocks.filter((block) =>
              block.transactions.some(
                  (transaction) =>
                      transaction.sender === selectedAddress || transaction.receiver === selectedAddress,
              ),
          )
        : blocks;
    const sortedBlocks = [...filteredBlocks].reverse();
    const recentBlocks = sortedBlocks.slice(0, visibleBlocks);
    const latestBlock = filteredBlocks.at(-1);
    const pendingTransactions = blockchain?.pending_transactions?.length ?? 0;

    useEffect(() => {
        setVisibleBlocks((current) => {
            if (filteredBlocks.length === 0) {
                return INITIAL_BLOCKS_VISIBLE;
            }

            return Math.min(Math.max(current, INITIAL_BLOCKS_VISIBLE), filteredBlocks.length);
        });
    }, [filteredBlocks.length]);

    useEffect(() => {
        const onScroll = () => {
            setShowScrollTop(window.scrollY > 320);

            const nearBottom =
                window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 300;

            if (!nearBottom) {
                return;
            }

            setVisibleBlocks((current) => {
                if (current >= sortedBlocks.length) {
                    return current;
                }

                return Math.min(current + BLOCKS_PER_BATCH, sortedBlocks.length);
            });
        };

        window.addEventListener("scroll", onScroll);
        onScroll();

        return () => {
            window.removeEventListener("scroll", onScroll);
        };
    }, [sortedBlocks.length]);

    useEffect(() => {
        if (!scrollToBottomRequested || visibleBlocks < sortedBlocks.length) {
            return;
        }

        const frame = window.requestAnimationFrame(() => {
            window.scrollTo({
                top: document.documentElement.scrollHeight,
                behavior: "smooth",
            });
            setScrollToBottomRequested(false);
        });

        return () => {
            window.cancelAnimationFrame(frame);
        };
    }, [scrollToBottomRequested, visibleBlocks, sortedBlocks.length]);

    const scrollToBottom = () => {
        setVisibleBlocks(sortedBlocks.length);
        setScrollToBottomRequested(true);
    };

    const scrollToTop = () => {
        const scroller = document.scrollingElement ?? document.documentElement ?? document.body;

        scroller.scrollTo({
            top: 0,
            behavior: "smooth",
        });

        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
    };

    return (
        <div className="balances-page blockchain-page">
            <header className="masthead masthead-left">
                <p className="masthead-kicker">Chain View</p>
                <h1 className="balances-title">UncCoin Blockchain</h1>
                <p className="masthead-subtitle">
                    Current chain state, recent blocks, and transaction details from the live blockchain file.
                </p>
            </header>

            <div className="page-actions">
                <div className="investment-cta">
                    <Link className="investment-link" to="/">
                        Back to balances
                    </Link>
                </div>
                <div className="investment-cta">
                    <button className="investment-link investment-button" type="button" onClick={scrollToBottom}>
                        Scroll to bottom
                    </button>
                </div>
            </div>

            <section className="balances-shell" aria-label="UncCoin blockchain overview">
                <div className="balances-meta">
                    <span className="balances-section-title">Blockchain Overview</span>
                    <p className="last-updated">
                        Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "loading..."}
                    </p>
                </div>

                <div className="blockchain-toolbar">
                    <label className="blockchain-filter">
                        <span className="chain-stat-label">Filter by address</span>
                        <select
                            className="blockchain-select"
                            value={selectedAddress}
                            onChange={(event) => {
                                setSelectedAddress(event.target.value);
                                setScrollToBottomRequested(false);
                            }}
                        >
                            <option value="">All addresses</option>
                            {addresses.map((address) => (
                                <option key={address} value={address}>
                                    {address}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        className="investment-link investment-button"
                        type="button"
                        onClick={() => {
                            setSelectedAddress("");
                            setScrollToBottomRequested(false);
                        }}
                        disabled={!selectedAddress}
                    >
                        Reset filter
                    </button>
                </div>

                <div className="chain-stats">
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Blocks</span>
                        <strong className="chain-stat-value">{filteredBlocks.length}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Latest Block</span>
                        <strong className="chain-stat-value">{latestBlock?.block_id ?? "-"}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Difficulty Bits</span>
                        <strong className="chain-stat-value">{blockchain?.difficulty_bits ?? "-"}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Pending Tx</span>
                        <strong className="chain-stat-value">{pendingTransactions}</strong>
                    </article>
                </div>

                <div className="chain-wallet-card">
                    <span className="chain-stat-label">Wallet Address</span>
                    <code className="chain-wallet-value">{blockchain?.wallet_address ?? "loading..."}</code>
                </div>

                <div className="block-list">
                    {recentBlocks.map((block) => (
                        <article key={block.block_id} className="block-card">
                            <div className="block-card-header">
                                <div>
                                    <p className="block-id">Block #{block.block_id}</p>
                                    <p className="block-description">{block.description || "No description"}</p>
                                </div>
                                <div className="block-card-meta">
                                    <span>{block.transactions.length} tx</span>
                                    <span>Nonce: {block.nonce}</span>
                                </div>
                            </div>

                            <div className="hash-grid">
                                <div>
                                    <span className="hash-label">Hash</span>
                                    <code className="hash-value" title={block.block_hash}>
                                        {truncateHash(block.block_hash)}
                                    </code>
                                </div>
                                <div>
                                    <span className="hash-label">Prev</span>
                                    <code className="hash-value" title={block.previous_hash}>
                                        {truncateHash(block.previous_hash)}
                                    </code>
                                </div>
                            </div>

                            <div className="transaction-list">
                                {block.transactions.length === 0 ? (
                                    <p className="empty-state">No transactions in this block.</p>
                                ) : (
                                    block.transactions.map((transaction, index) => (
                                        <div
                                            key={`${block.block_id}-${transaction.timestamp}-${index}`}
                                            className="transaction-row"
                                        >
                                            <div>
                                                <span className="hash-label">From</span>
                                                <code className="hash-value" title={transaction.sender}>
                                                    {truncateHash(transaction.sender)}
                                                </code>
                                            </div>
                                            <div>
                                                <span className="hash-label">To</span>
                                                <code className="hash-value" title={transaction.receiver}>
                                                    {truncateHash(transaction.receiver)}
                                                </code>
                                            </div>
                                            <div>
                                                <span className="hash-label">Amount</span>
                                                <span className="transaction-amount">{transaction.amount}</span>
                                            </div>
                                            <div>
                                                <span className="hash-label">Timestamp</span>
                                                <span className="transaction-time">
                                                    {formatTimestamp(transaction.timestamp)}
                                                </span>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </article>
                    ))}
                </div>

                {visibleBlocks < sortedBlocks.length ? (
                    <p className="blockchain-loading-more">Scroll down to load more blocks...</p>
                ) : null}
            </section>

            {showScrollTop ? (
                <button className="scroll-top-button" type="button" onClick={scrollToTop}>
                    Top
                </button>
            ) : null}
        </div>
    );
}

export default function App() {
    return (
        <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/blockchain" element={<BlockchainPage />} />
        </Routes>
    );
}
