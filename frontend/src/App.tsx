import { useEffect, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { getBalances, type BalanceRow } from "./api/balances";
import { getBlockchain, type BlockchainBlock, type BlockchainResponse } from "./api/blockchain";
import "./App.css";

const INITIAL_BLOCKS_VISIBLE = 25;
const BLOCKS_PER_BATCH = 25;
const CHART_WIDTH = 920;
const CHART_HEIGHT = 352;
const CHART_PADDING = 64;
const CHART_TICK_COUNT = 6;
const CHART_Y_TICK_COUNT = 5;

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

function parseAmount(value: string): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

type SupplyPoint = {
    timestamp: string;
    totalSupply: number;
    label: string;
    dateLabel: string;
    timeLabel: string;
};

function buildSupplySeries(blocks: BlockchainBlock[]): SupplyPoint[] {
    let totalSupply = 0;
    const series: SupplyPoint[] = [];

    for (const block of blocks) {
        let blockTimestamp: string | null = null;

        for (const transaction of block.transactions) {
            if (!blockTimestamp) {
                blockTimestamp = transaction.timestamp;
            }

            if (transaction.sender === "SYSTEM") {
                totalSupply += parseAmount(transaction.amount);
            }

            if (transaction.receiver === "SYSTEM") {
                totalSupply -= parseAmount(transaction.amount);
            }
        }

        if (blockTimestamp) {
            const parsed = new Date(blockTimestamp);
            const dateLabel = Number.isNaN(parsed.getTime())
                ? blockTimestamp
                : parsed.toLocaleDateString();
            const timeLabel = Number.isNaN(parsed.getTime())
                ? ""
                : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

            series.push({
                timestamp: blockTimestamp,
                totalSupply,
                label: formatTimestamp(blockTimestamp),
                dateLabel,
                timeLabel,
            });
        }
    }

    return series;
}

function getTickIndices(length: number, desiredCount: number): number[] {
    if (length <= 0) {
        return [];
    }

    if (length <= desiredCount) {
        return Array.from({ length }, (_, index) => index);
    }

    const indices = new Set<number>();

    for (let step = 0; step < desiredCount; step += 1) {
        const index = Math.round((step / (desiredCount - 1)) * (length - 1));
        indices.add(index);
    }

    return [...indices].sort((left, right) => left - right);
}

type YAxisTick = {
    value: number;
    y: number;
};

function buildYAxisTicks(maxSupply: number): YAxisTick[] {
    return Array.from({ length: CHART_Y_TICK_COUNT }, (_, index) => {
        const ratio = index / (CHART_Y_TICK_COUNT - 1);
        const value = Math.round((1 - ratio) * maxSupply);
        const y = CHART_PADDING + ratio * (CHART_HEIGHT - CHART_PADDING * 2);

        return { value, y };
    });
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
                <div className="investment-cta">
                    <Link className="investment-link" to="/stat">
                        View stats
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

function StatPage() {
    const [blockchain, setBlockchain] = useState<BlockchainResponse | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

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

    const blocks = blockchain?.blocks ?? [];
    const supplySeries = buildSupplySeries(blocks);
    const latestPoint = supplySeries.at(-1);
    const firstPoint = supplySeries[0];
    const maxSupply = supplySeries.reduce((max, point) => Math.max(max, point.totalSupply), 0);

    const points = supplySeries.map((point, index) => {
        const x =
            supplySeries.length <= 1
                ? CHART_PADDING
                : CHART_PADDING + (index / (supplySeries.length - 1)) * (CHART_WIDTH - CHART_PADDING * 2);
        const y =
            maxSupply === 0
                ? CHART_HEIGHT - CHART_PADDING
                : CHART_HEIGHT -
                  CHART_PADDING -
                  (point.totalSupply / maxSupply) * (CHART_HEIGHT - CHART_PADDING * 2);
        return { ...point, x, y };
    });

    const polylinePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
    const xAxisY = CHART_HEIGHT - CHART_PADDING;
    const yAxisX = CHART_PADDING;
    const tickIndices = getTickIndices(points.length, CHART_TICK_COUNT);
    const tickPoints = tickIndices.map((index) => points[index]).filter(Boolean);
    const yAxisTicks = buildYAxisTicks(maxSupply);

    return (
        <div className="balances-page">
            <header className="masthead masthead-left">
                <p className="masthead-kicker">Stats</p>
                <h1 className="balances-title">UncCoin Supply</h1>
                <p className="masthead-subtitle">
                    Total UncCoins in existence over time, derived from blockchain timestamps and SYSTEM issuance.
                </p>
            </header>

            <div className="page-actions">
                <div className="investment-cta">
                    <Link className="investment-link" to="/">
                        Back to balances
                    </Link>
                </div>
                <div className="investment-cta">
                    <Link className="investment-link" to="/blockchain">
                        View blockchain
                    </Link>
                </div>
            </div>

            <section className="balances-shell" aria-label="UncCoin supply statistics">
                <div className="balances-meta">
                    <span className="balances-section-title">Supply Curve</span>
                    <p className="last-updated">
                        Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "loading..."}
                    </p>
                </div>

                <div className="chain-stats">
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Current Supply</span>
                        <strong className="chain-stat-value">{latestPoint?.totalSupply ?? 0}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Data Points</span>
                        <strong className="chain-stat-value">{supplySeries.length}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Start</span>
                        <strong className="chain-stat-mini">{firstPoint ? formatTimestamp(firstPoint.timestamp) : "-"}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Latest</span>
                        <strong className="chain-stat-mini">{latestPoint ? formatTimestamp(latestPoint.timestamp) : "-"}</strong>
                    </article>
                </div>

                <div className="stat-chart-card">
                    {points.length > 0 ? (
                        <>
                            <div className="stat-chart-scroll">
                                <svg
                                    className="stat-chart"
                                    viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                                    role="img"
                                    aria-label="Line chart of total UncCoins in existence over time"
                                >
                                    <line
                                        className="stat-axis"
                                        x1={yAxisX}
                                        y1={CHART_PADDING}
                                        x2={yAxisX}
                                        y2={xAxisY}
                                    />
                                    <line
                                        className="stat-axis"
                                        x1={yAxisX}
                                        y1={xAxisY}
                                        x2={CHART_WIDTH - CHART_PADDING}
                                        y2={xAxisY}
                                    />
                                    <line
                                        className="stat-grid"
                                        x1={yAxisX}
                                        y1={CHART_PADDING}
                                        x2={CHART_WIDTH - CHART_PADDING}
                                        y2={CHART_PADDING}
                                    />
                                    {yAxisTicks.map((tick) => (
                                        <line
                                            key={`y-grid-${tick.value}-${tick.y}`}
                                            className="stat-grid"
                                            x1={yAxisX}
                                            y1={tick.y}
                                            x2={CHART_WIDTH - CHART_PADDING}
                                            y2={tick.y}
                                        />
                                    ))}
                                    {tickPoints.map((point) => (
                                        <line
                                            key={`grid-${point.timestamp}-${point.x}`}
                                            className="stat-grid-vertical"
                                            x1={point.x}
                                            y1={CHART_PADDING}
                                            x2={point.x}
                                            y2={xAxisY}
                                        />
                                    ))}
                                    <polyline className="stat-line" points={polylinePoints} />
                                    {tickPoints.map((point) => (
                                        <circle
                                            key={`point-${point.timestamp}-${point.x}`}
                                            className="stat-point"
                                            cx={point.x}
                                            cy={point.y}
                                            r="3.5"
                                        />
                                    ))}
                                    {yAxisTicks.map((tick) => (
                                        <text
                                            key={`y-label-${tick.value}-${tick.y}`}
                                            className="stat-label stat-label-y"
                                            x={yAxisX - 10}
                                            y={tick.y + 4}
                                        >
                                            {tick.value}
                                        </text>
                                    ))}
                                    {tickPoints.map((point, index) => (
                                        <text
                                            key={`label-${point.timestamp}-${point.x}`}
                                            className={`stat-label ${
                                                index === 0
                                                    ? ""
                                                    : index === tickPoints.length - 1
                                                      ? "stat-label-end"
                                                      : "stat-label-middle"
                                            }`}
                                            x={point.x}
                                            y={CHART_HEIGHT - 26}
                                        >
                                            <tspan x={point.x} dy="0">
                                                {point.dateLabel}
                                            </tspan>
                                            <tspan x={point.x} dy="14">
                                                {point.timeLabel}
                                            </tspan>
                                        </text>
                                    ))}
                                </svg>
                            </div>
                            <p className="stat-chart-note">
                                Supply is calculated as cumulative SYSTEM issuance minus transfers back to SYSTEM.
                            </p>
                        </>
                    ) : (
                        <p className="empty-state">No timestamped blockchain transactions available yet.</p>
                    )}
                </div>
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
                    <Link className="investment-link" to="/stat">
                        View stats
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
            <Route path="/stat" element={<StatPage />} />
        </Routes>
    );
}
