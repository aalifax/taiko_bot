require('dotenv').config();
const config = require('../config/config.json');

module.exports = {
    WETH_ADDRESS: process.env.WETH_CONTRACT_ADDRESS || "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    VOTE_ADDRESS: process.env.VOTE_CONTRACT_ADDRESS || "0x4D1E2145082d0AB0fDa4a973dC4887C7295e21aB",
    RPC_URL: process.env.RPC_URL || "https://eth.llamarpc.com/",
    REQUIRED_CONFIRMATIONS: config.confirmation.required,
    MAX_RETRIES: config.confirmation.maxRetries,
    RETRY_DELAY: config.confirmation.retryDelay,
    WETH_ABI: require('../config/abi.json'),
    VOTE_ABI: [
        {
            "stateMutability": "payable",
            "type": "fallback"
        },
        {
            "inputs": [],
            "name": "vote",
            "outputs": [],
            "stateMutability": "payable",
            "type": "function"
        }
    ]
};
