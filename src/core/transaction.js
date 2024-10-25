const { ethers, provider } = require('../services/ethereum');
const { sleep } = require('../utils/time');
const { chalk } = require('../utils/logger');
const { logWithBorder } = require('../utils/logger');
const { CONTRACT_ADDRESS, REQUIRED_CONFIRMATIONS, MAX_RETRIES, RETRY_DELAY } = require('../constants');
const { fetchTaikoPoints } = require('../services/points');
const { getCurrentServerTime } = require('../utils/time');
const fs = require('fs');
const config = require('../../config/config.json');

const walletFees = new Map();
const walletPoints = new Map();
const pendingTransactions = new Map();

async function waitForAllConfirmations(transactions, requiredConfirmations) {
    const confirmationStates = new Map(
        transactions.map(({ hash, walletIndex }) => [hash, { confirmations: 0, walletIndex }])
    );

    process.stdout.write(chalk.yellow(`\n${"-".repeat(100)}\n⏳ Waiting for confirmations...\n`));

    const confirmedReceipts = [];

    while (confirmationStates.size > 0) {
        try {
            let statusLine = "";

            await Promise.all(
                Array.from(confirmationStates.entries()).map(async ([txHash, state]) => {
                    const receipt = await provider.getTransactionReceipt(txHash);

                    if (!receipt || !receipt.blockNumber) {
                        statusLine += chalk.yellow(`[Wallet-${state.walletIndex + 1}: Pending] `);
                        return;
                    }

                    const currentBlock = await provider.getBlockNumber();
                    const confirmations = Math.max(currentBlock - receipt.blockNumber + 1, 0);

                    if (confirmations >= requiredConfirmations) {
                        confirmationStates.delete(txHash);
                        confirmedReceipts.push({ receipt, walletIndex: state.walletIndex });
                    } else {
                        statusLine += chalk.yellow(`[Wallet-${state.walletIndex + 1}: ${confirmations}/${requiredConfirmations}] `);
                    }
                })
            );

            process.stdout.write(`\r${" ".repeat(100)}\r${statusLine}`);

            if (confirmationStates.size > 0) {
                await sleep(5000);
            }
        } catch (error) {
            console.error(chalk.red(`\n✗ Error checking confirmations: ${error}`));
            await sleep(5000);
        }
    }

    console.log(chalk.green(`\n✓ All transactions confirmed!\n${"-".repeat(100)}`));
    return confirmedReceipts;
}

async function executeTransactions(operations, description) {
    const transactions = [];

    console.log(chalk.cyan(`\n📤 Executing ${description}...`));

    await Promise.all(
        operations.map(async ({ operation, walletIndex }) => {
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const tx = await operation();
                    console.log(chalk.yellow(`🔄 Wallet-${walletIndex + 1} ${description} Hash:`), chalk.blue(tx.hash));
                    transactions.push({ hash: tx.hash, walletIndex });
                    break;
                } catch (error) {
                    logWithBorder(chalk.red(`✗ Wallet-${walletIndex + 1} - Attempt ${attempt} failed: ${error.message}`));

                    if (attempt === MAX_RETRIES) {
                        throw new Error(`Wallet-${walletIndex + 1} - Failed after ${MAX_RETRIES} attempts: ${error.message}`);
                    }

                    console.log(chalk.yellow(`⏳ Waiting ${RETRY_DELAY / 1000} seconds before retry...`));
                    await sleep(RETRY_DELAY);
                }
            }
        })
    );

    const confirmedReceipts = await waitForAllConfirmations(transactions, REQUIRED_CONFIRMATIONS);

    confirmedReceipts.forEach(({ receipt, walletIndex }) => {
        const actualFee = receipt.gasUsed.mul(receipt.effectiveGasPrice);
        const currentWalletFee = walletFees.get(walletIndex) || ethers.BigNumber.from(0);
        walletFees.set(walletIndex, currentWalletFee.add(actualFee));
    });

    return confirmedReceipts;
}

async function processWallets(walletConfigs, iteration) {
    logWithBorder(
        chalk.cyan(`📌 [${getCurrentServerTime()}] Starting iteration ${iteration + 1}`)
    );

    // Initialize wallet info
    const walletInfos = await Promise.all(
        walletConfigs.map(async ({ privateKey, config: walletConfig }, index) => {
            const wallet = new ethers.Wallet(privateKey, provider);
            const points = await fetchTaikoPoints(wallet.address);
            const balance = await provider.getBalance(wallet.address);

            console.log(chalk.cyan(`\n🔷 Wallet-${index + 1} Status:`));
            if (points) {
                console.log(chalk.blue("📊 Initial Points:"), chalk.yellow(points.totalPoints.toFixed(2)));
                console.log(chalk.blue("🏆 Current Rank:"), chalk.yellow(points.rank));
            }
            console.log(chalk.blue("💎 Current balance:"), chalk.yellow(ethers.utils.formatEther(balance)), "ETH");
            console.log(chalk.blue("⚙️ Configured amount range:"),
                chalk.yellow(`${walletConfig.amount_min} - ${walletConfig.amount_max}`), "ETH");

            return { wallet, points, balance, index, config: walletConfig };
        })
    );

    // Prepare deposit operations
    const depositOperations = walletInfos.map(({ wallet, balance, index, config: walletConfig }) => {
        const contract = new ethers.Contract(CONTRACT_ADDRESS, JSON.parse(fs.readFileSync("config/abi.json", "utf8")), wallet);
        const min = ethers.utils.parseEther(walletConfig.amount_min);
        const max = ethers.utils.parseEther(walletConfig.amount_max);
        const randomAmount = ethers.BigNumber.from(ethers.utils.randomBytes(32))
            .mod(max.sub(min))
            .add(min);

        console.log(
            chalk.blue(`🎲 Wallet-${index + 1} Random deposit amount:`),
            chalk.yellow(ethers.utils.formatEther(randomAmount)),
            "ETH"
        );

        if (balance.lt(randomAmount)) {
            console.log(chalk.red(`⚠️ Wallet-${index + 1}: Insufficient balance for deposit`));
            return null;
        }

        return {
            operation: () =>
                contract.deposit({
                    value: randomAmount,
                    gasPrice: ethers.utils.parseUnits(config.gasPrice, "gwei"),
                    gasLimit: 104817,
                }),
            walletIndex: index,
        };
    }).filter(Boolean);

    // Execute deposits
    if (depositOperations.length > 0) {
        await executeTransactions(depositOperations, "Deposit");
    }

    await sleep(config.interval * 1000);

    // Prepare withdraw operations
    const withdrawOperations = await Promise.all(
        walletInfos.map(async ({ wallet, index }) => {
            const contract = new ethers.Contract(CONTRACT_ADDRESS, JSON.parse(fs.readFileSync("config/abi.json", "utf8")), wallet);
            const wethBalance = await contract.balanceOf(wallet.address);

            console.log(
                chalk.blue(`💎 Wallet-${index + 1} WETH balance:`),
                chalk.yellow(ethers.utils.formatEther(wethBalance)),
                "WETH"
            );

            if (wethBalance.isZero()) {
                console.log(chalk.red(`⚠️ Wallet-${index + 1}: No WETH balance to withdraw`));
                return null;
            }

            return {
                operation: () =>
                    contract.withdraw(wethBalance, {
                        gasPrice: ethers.utils.parseUnits(config.gasPrice, "gwei"),
                        gasLimit: 100000,
                    }),
                walletIndex: index,
            };
        })
    );

    // Execute withdrawals
    const validWithdrawOperations = withdrawOperations.filter(Boolean);
    if (validWithdrawOperations.length > 0) {
        await executeTransactions(validWithdrawOperations, "Withdraw");
    }

    // Wait for API update and fetch final points
    await sleep(5000);

    await Promise.all(
        walletInfos.map(async ({ wallet, points: initialPoints, index }) => {
            const finalPoints = await fetchTaikoPoints(wallet.address);
            if (finalPoints && initialPoints) {
                const pointsDifference = finalPoints.totalPoints - initialPoints.totalPoints;
                console.log(chalk.blue(`📊 Wallet-${index + 1} Points earned:`), chalk.green(`+${pointsDifference.toFixed(2)}`));
                console.log(
                    chalk.blue(`🏆 Wallet-${index + 1} New Rank:`),
                    chalk.yellow(finalPoints.rank),
                    finalPoints.rank < initialPoints.rank
                        ? chalk.green(`(↑${initialPoints.rank - finalPoints.rank})`)
                        : ""
                );

                if (!walletPoints.has(wallet.address)) {
                    walletPoints.set(wallet.address, []);
                }
                walletPoints.get(wallet.address).push({
                    iteration: iteration + 1,
                    pointsEarned: pointsDifference,
                    totalPoints: finalPoints.totalPoints,
                    rank: finalPoints.rank,
                    rankChange: initialPoints.rank - finalPoints.rank
                });
            }
        })
    );
    logWithBorder(
        chalk.green(`✓ [${getCurrentServerTime()}] Completed iteration ${iteration + 1}`)
    );
}

module.exports = {
    walletFees,
    walletPoints,
    executeTransactions,
    waitForAllConfirmations,
    processWallets
};