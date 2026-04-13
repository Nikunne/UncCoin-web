import { useEffect, useState } from "react";
import { getBalances, type BalanceRow } from "./api/balances";
import "./App.css";

export default function App() {
    const [balances, setBalances] = useState<BalanceRow[]>([]);

    useEffect(() => {
        getBalances().then(setBalances).catch(console.error);
    }, []);

    return (
        <div className="balances-page">
            <h1 className="balances-title">₿ Balances</h1>

            <div className="balances-card">
                {balances.map(([user, amount]) => (
                    <div key={user} className="balance-row">
                        <span className="balance-user">{user}</span>
                        <span className="balance-amount">{amount}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}