const bitcoin = require('bitgo-utxo-lib')
const util = require('./util.js')

const scriptCompile = addrHash => bitcoin.script.compile([
    bitcoin.opcodes.OP_DUP,
    bitcoin.opcodes.OP_HASH160,
    addrHash,
    bitcoin.opcodes.OP_EQUALVERIFY,
    bitcoin.opcodes.OP_CHECKSIG
])

const scriptFoundersCompile = address => bitcoin.script.compile([
    bitcoin.opcodes.OP_HASH160,
    address,
    bitcoin.opcodes.OP_EQUAL
])


/*
This function creates the generation transaction that accepts the reward for
successfully mining a new block.
For some (probably outdated and incorrect) documentation about whats kinda going on here,
see: https://en.bitcoin.it/wiki/Protocol_specification#tx
 */

// public members
let txHash
exports.txHash = () => txHash

exports.createGeneration = (rpcData, blockReward, recipients, poolAddress, poolHex, extraNoncePlaceholder, coin, auxMerkleTree) => {
	
	const poolAddrHash = bitcoin.address.fromBase58Check(poolAddress).hash
	let txMessages = coin.txMessages;
	let reward = coin.reward;
	const feeReward = rpcData.rewardFees;
    let txb = null;
	
	let masternodeReward = rpcData.payee_amount;
    let masternodePayee = rpcData.payee;
    let masternodePayment = rpcData.masternode_payments;
    const zelnodeBasicAddress = coin.payZelNodes ? rpcData.basic_zelnode_address : null;
    const zelnodeBasicAmount = coin.payZelNodes ? (rpcData.basic_zelnode_payout || 0) : 0;
    const zelnodeSuperAddress = coin.payZelNodes ? rpcData.super_zelnode_address : null;
    const zelnodeSuperAmount = coin.payZelNodes ? (rpcData.super_zelnode_payout || 0) : 0;
    const zelnodeBamfAddress = coin.payZelNodes ? rpcData.bamf_zelnode_address : null;
    const zelnodeBamfAmount = coin.payZelNodes ? (rpcData.bamf_zelnode_payout || 0): 0;
	let payZelNodeRewards = false;
    if (coin.payZelNodes === true || (typeof coin.payZelNodes === 'number' && coin.payZelNodes <= Date.now() / 1000 )) {
        payZelNodeRewards = true;
    }
	let txOutputsCount = 1;
	let txLockTime = 0;
	let txInSequence = 0;
	let txExtraPayload;
	let scriptSigPart1;
	let scriptSigPart2;
	let p1;
	let p2;
	const txComment = txMessages === true ?
		util.serializeString('https://github.com/cod3gen') :
		new Buffer([]);
	const txInPrevOutIndex = Math.pow(2, 32) - 1;
	
	
	if (util.isZ(coin)) { // input for coinbase tx: equihash or similiar coin which currently uses bitgo-utxo-lib to generate transaction... Todo: Other coins should be merged into this function.
		txb = new bitcoin.TransactionBuilder(coin.network)
		if (coin.sapling === true || (typeof coin.sapling === 'number' && coin.sapling <= rpcData.height)) {
			txb.setVersion(bitcoin.Transaction.ZCASH_SAPLING_VERSION);
		} else if (coin.overwinter === true || (typeof coin.overwinter === 'number' && coin.overwinter <= rpcData.height)) {
			txb.setVersion(bitcoin.Transaction.ZCASH_OVERWINTER_VERSION);
		}
		
		// input for coinbase tx
		let blockHeightSerial = (rpcData.height.toString(16).length % 2 === 0 ? '' : '0') + rpcData.height.toString(16)

		let height = Math.ceil((rpcData.height << 1).toString(2).length / 8)
		let lengthDiff = blockHeightSerial.length / 2 - height
		for (let i = 0; i < lengthDiff; i++) {
			blockHeightSerial = `${blockHeightSerial}00`
		}

		let length = `0${height}`
		let serializedBlockHeight = new Buffer.concat([
			new Buffer(length, 'hex'),
			util.reverseBuffer(new Buffer(blockHeightSerial, 'hex')),
			new Buffer('00', 'hex') // OP_0
		])

		txb.addInput(new Buffer('0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
			txInPrevOutIndex,
			txInPrevOutIndex,
			new Buffer.concat([
				serializedBlockHeight,
				// Default s-nomp pool https://github.com/s-nomp/s-nomp/wiki/Insight-pool-link
				Buffer(poolHex ? poolHex : '44656661756C7420732D6E6F6D7020706F6F6C2068747470733A2F2F6769746875622E636F6D2F732D6E6F6D702F732D6E6F6D702F77696B692F496E73696768742D706F6F6C2D6C696E6B', 'hex')
			])
		)
	}
	else {
		let txVersion = txMessages === true ? 2 : 1;
		let txType = 0;

		if (rpcData.coinbase_payload && rpcData.coinbase_payload.length > 0) {
			txVersion = 3;
			txType = 5;
			txExtraPayload = new Buffer(rpcData.coinbase_payload, 'hex');
		}

		txVersion = txVersion + (txType << 16);

		//Only required for POS coins
		var txTimestamp = reward === 'POS' ?
			util.packUInt32LE(rpcData.curtime) : new Buffer([]);

		scriptSigPart1 = Buffer.concat([
			util.serializeNumber(rpcData.height),
			new Buffer(rpcData.coinbaseaux.flags, 'hex'),
			util.serializeNumber(Date.now() / 1000 | 0),
			new Buffer([extraNoncePlaceholder.length]),
			new Buffer('fabe6d6d', 'hex'),
			util.reverseBuffer(auxMerkleTree.root),
			util.packUInt32LE(auxMerkleTree.data.length),
			util.packUInt32LE(0)
		]);

		scriptSigPart2 = util.serializeString('/node-stratum-pool/');

		p1 = Buffer.concat([
			util.packUInt32LE(txVersion),
			txTimestamp,
			util.varIntBuffer(1),
			util.uint256BufferFromHash("0"), // 0000000000000000000000000000000000000000000000000000000000000000
			util.packUInt32LE(txInPrevOutIndex),
			util.varIntBuffer(scriptSigPart1.length + extraNoncePlaceholder.length + scriptSigPart2.length),
			scriptSigPart1
		]);
	}
	
    let feePercent = 0
	
	let charityPosition = coin.charityPosition; // Set fee(s) before or after available tx
	let charityPercent = coin.charityPercent;
	let charityAmount = coin.charityAmount;
	let charityAddress = coin.charityAddress;
	let charityAddresses = coin.charityAddresses;
	let charityOutputs = {};
	let masterNodePosition = coin.masterNodePosition;
	let masterNodePercent = coin.masterNodePercent;
	let masterNodeAmount = coin.masterNodeAmount;
	let masterNodeAddress = coin.masterNodeAddress;
	let masterNodeAddresses = coin.masterNodeAddresses;
	let masterNodeOutputs = {};
	
	let extraPosition = 0;
	let extraOutputs = coin.extraOutsputs? coin.extraOutsputs : [];
	let poolOutput = [];
	let recipientsOutputs = [];
	let recipientsAmount = 0;
	let poolOutputAmount = 0;
	let available = Math.round(blockReward.coinbase);
	
	// Create pool fee outputs in its own array
    if (recipients.length > 0 && recipients[0].address != '') {
        let burn = 0
        if (coin.burnFees) {
            burn = feeReward
        }
        recipients.forEach(recipient => {
			recipientsOutputs.push({
				'script': scriptCompile(bitcoin.address.fromBase58Check(recipient.address).hash),
				'address': recipient.address,
				'amount': Math.round(blockReward.total? blockReward.total : available * (recipient.percent / 100) - burn)
			});
			feePercent += recipient.percent;
			recipientsAmount += Math.round(blockReward.total? blockReward.total : available * (recipient.percent / 100) - burn);
            burn = 0
        })
    }
	
	
	
	if (util.isZ(coin)) {// TODO: This sorely needs to be updated and simplified
		if ((masternodePayment === false || masternodePayment === undefined) && payZelNodeRewards === false && !rpcData.coinbase_required_outputs) {
			if (coin.payFoundersReward === true && ((coin.maxFoundersRewardBlockHeight >= rpcData.height || coin.treasuryRewardStartBlockHeight || coin.treasuryRewardUpdateStartBlockHeight || coin.treasuryReward20pctUpdateStartBlockHeight) || coin.payAllFounders === true)) {
				if ((coin.treasuryRewardUpdateStartBlockHeight || coin.treasuryReward20pctUpdateStartBlockHeight) && rpcData.height >= (coin.treasuryRewardUpdateStartBlockHeight || coin.treasuryReward20pctUpdateStartBlockHeight)) {
					let percentTreasuryReward = coin.percentTreasuryUpdateReward
					let treasuryRewardStartBlockHeight = coin.treasuryRewardUpdateStartBlockHeight
					if (coin.treasuryReward20pctUpdateStartBlockHeight && rpcData.height >= coin.treasuryReward20pctUpdateStartBlockHeight) {
						percentTreasuryReward = coin.percentTreasury20pctUpdateReward
						treasuryRewardStartBlockHeight = coin.treasuryReward20pctUpdateStartBlockHeight
					}
					let indexCF = parseInt(Math.floor(((rpcData.height - treasuryRewardStartBlockHeight) / coin.treasuryRewardUpdateAddressChangeInterval) % coin.vTreasuryRewardUpdateAddress.length))
					let indexSN = parseInt(Math.floor(((rpcData.height - coin.treasuryRewardUpdateStartBlockHeight) / coin.treasuryRewardUpdateAddressChangeInterval) % coin.vSecureNodesRewardAddress.length))
					let indexXN = parseInt(Math.floor(((rpcData.height - coin.treasuryRewardUpdateStartBlockHeight) / coin.treasuryRewardUpdateAddressChangeInterval) % coin.vSuperNodesRewardAddress.length))
					
					poolOutputAmount = Math.round(blockReward.total * (1 - (percentTreasuryReward + coin.percentSecureNodesReward + coin.percentSuperNodesReward + feePercent) / 100)) + feeReward;
					extraPosition = 1;
					extraOutputs.push({
						script: scriptFoundersCompile(bitcoin.address.fromBase58Check(coin.vTreasuryRewardUpdateAddress[indexCF]).hash),
						address: null,
						amount: Math.round(blockReward.total * (percentTreasuryReward / 100))
					});
					
					extraOutputs.push({
						script: scriptFoundersCompile(bitcoin.address.fromBase58Check(coin.vSecureNodesRewardAddress[indexSN]).hash),
						address: null,
						amount: Math.round(blockReward.total * (coin.percentSecureNodesReward / 100))
					});
					
					extraOutputs.push({
						script: scriptFoundersCompile(bitcoin.address.fromBase58Check(coin.vSuperNodesRewardAddress[indexXN]).hash),
						address: null,
						amount: Math.round(blockReward.total * (coin.percentSuperNodesReward / 100))
					});
				} else if (coin.treasuryRewardStartBlockHeight && rpcData.height >= coin.treasuryRewardStartBlockHeight) {
					let index = parseInt(Math.floor(((rpcData.height - coin.treasuryRewardStartBlockHeight) / coin.treasuryRewardAddressChangeInterval) % coin.vTreasuryRewardAddress.length))
					poolOutputAmount = Math.round(blockReward.total * (1 - (percentTreasuryReward + coin.percentSecureNodesReward + coin.percentSuperNodesReward + feePercent) / 100)) + feeReward;
					extraPosition = 1;
					extraOutputs.push({
						script: scriptFoundersCompile(bitcoin.address.fromBase58Check(coin.vTreasuryRewardAddress[index]).hash),
						address: null,
						amount: Math.round(blockReward.total * (coin.percentTreasuryReward / 100))
					});
				} else if (coin.payAllFounders === true) {
					var poolFeeDeductionTotalPercent = 0;
					recipients.forEach(function (recipient) {
						poolFeeDeductionTotalPercent += recipient.percent;
					});
					
					var poolDeductionAmount = Math.round(blockReward.total * (poolFeeDeductionTotalPercent / 100));

					poolOutputAmount = blockReward.miner - poolDeductionAmount + feeReward;
					extraPosition = 1;
					
					if (rpcData.infrastructure && rpcData.infrastructure > 0)
						extraOutputs.push({
							script: scriptFoundersCompile(bitcoin.address.fromBase58Check(coin.infrastructureAddresses[0]).hash),
							address: null,
							amount: blockReward.infrastructure
						});
					if (rpcData.giveaways && rpcData.giveaways > 0)
						extraOutputs.push({
							script: scriptFoundersCompile(bitcoin.address.fromBase58Check(coin.giveawayAddresses[0]).hash),
							address: null,
							amount: blockReward.giveaways
						});
					if (rpcData.founders && rpcData.founders.length > 0)
					{
						rpcData.founders.map((founderItem) => {
							extraOutputs.push({
								script: new Buffer(founderItem.script, 'hex'),
								address: null,
								amount: founderItem.amount
							});
						});
					}
					if (rpcData.masternodes && rpcData.masternodes.length > 0)
					{
						rpcData.masternodes.map((masternodeItem) => {
							extraOutputs.push({
								script: new Buffer(masternodeItem.script, 'hex'),
								address: null,
								amount: masternodeItem.amount
							});
						});
					}
					if (rpcData.governanceblock && rpcData.governanceblock.length > 0)
					{
						rpcData.governanceblock.map((governanceItem) => {
							extraOutputs.push({
								script: new Buffer(governanceItem.script, 'hex'),
								address: null,
								amount: governanceItem.amount
							});
						});
					}
				} else {
					let index = parseInt(Math.floor(rpcData.height / coin.foundersRewardAddressChangeInterval))
					let foundersAddrHash = bitcoin.address.fromBase58Check(coin.vFoundersRewardAddress[index]).hash

					extraPosition = 1;
					poolOutputAmount = Math.round(blockReward.total * (1 - (coin.percentFoundersReward + feePercent) / 100)) + feeReward

					extraOutputs.push({
						script: scriptFoundersCompile(foundersAddrHash),
						address: null,
						amount: Math.round(blockReward.total * (coin.percentFoundersReward / 100))
					});
				}
			} else {
				poolOutputAmount = Math.round(blockReward.total * (1 - (feePercent / 100))) + feeReward;
			}
		} else if (payZelNodeRewards === false && rpcData.coinbase_required_outputs && rpcData.coinbase_required_outputs.length) {
			let required_outputs_total = 0;

			rpcData.coinbase_required_outputs.map((output) => {
				if (output.type !== "superblock") {
					required_outputs_total += output.amount;
				}
				
				extraOutputs.push({
					script: new Buffer(output.script, 'hex'),
					address: null,
					amount: output.amount
				});
			})

			blockReward.total -= required_outputs_total;

			poolOutputAmount = ((blockReward.total) * (1 - feePercent / 100) + feeReward)
		} else if (payZelNodeRewards === false) {
			let masternodeAddrHash = masternodePayee ? bitcoin.address.fromBase58Check(masternodePayee).hash : null

			if(rpcData.founderAddress) {
				extraPosition = 1;
				poolOutputAmount = Math.round(blockReward.total * (1 - rpcData.founderReward / blockReward.total - feePercent / 100)) + feeReward - masternodeReward;

				extraOutputs.push({
					script: scriptFoundersCompile(bitcoin.address.fromBase58Check(rpcData.founderAddress).hash),
					address: null,
					amount: Math.round(rpcData.founderReward)
				});
				extraOutputs.push({
					script: scriptFoundersCompile(masternodeAddrHash),
					address: null,
					amount: Math.round(masternodeReward)
				});
			}
			else
			{
				if (coin.payFoundersReward === true && (coin.maxFoundersRewardBlockHeight >= rpcData.height || coin.treasuryRewardStartBlockHeight)) {
					if (coin.treasuryRewardStartBlockHeight && rpcData.height >= coin.treasuryRewardStartBlockHeight) {
						let index = parseInt(Math.floor(((rpcData.height - coin.treasuryRewardStartBlockHeight) / coin.treasuryRewardAddressChangeInterval) % coin.vTreasuryRewardAddress.length))

						extraPosition = 1;
						poolOutputAmount = Math.round(blockReward.total * (1 - (coin.percentTreasuryReward + feePercent) / 100)) + feeReward - masternodeReward;
						
						extraOutputs.push({
							script: scriptFoundersCompile(bitcoin.address.fromBase58Check(coin.vTreasuryRewardAddress[index]).hash),
							address: null,
							amount: Math.round(blockReward.total * (coin.percentTreasuryReward / 100))
						});
						extraOutputs.push({
							script: scriptFoundersCompile(masternodeAddrHash),
							address: null,
							amount: Math.round(masternodeReward)
						});
					} else {
						let index = parseInt(Math.floor(rpcData.height / coin.foundersRewardAddressChangeInterval))

						extraPosition = 1;
						poolOutputAmount = Math.round(blockReward.total * (1 - (coin.percentFoundersReward + feePercent) / 100)) + feeReward - masternodeReward
						
						extraOutputs.push({
							script: scriptFoundersCompile(bitcoin.address.fromBase58Check(coin.vFoundersRewardAddress[index]).hash),
							address: null,
							amount: Math.round(blockReward.total * (coin.percentFoundersReward / 100))
						});
						extraOutputs.push({
							script: scriptFoundersCompile(masternodeAddrHash),
							address: null,
							amount: Math.round(masternodeReward)
						});
					}
				} else {
					feeReward = feeReward || 0;
					feePercent = feePercent || 0;
					masternodeReward = masternodeReward || 0;

					extraPosition = 1;
					poolOutputAmount = Math.round(blockReward.total * (1 - (feePercent / 100))) + feeReward - masternodeReward;
					if (masternodeAddrHash) {
						extraOutputs.push({
							script: scriptCompile(masternodeAddrHash),
							address: null,
							amount: Math.round(masternodeReward)
						});
					}
				}
			}
		} else {
			let zelnodeBasicAddrHash = zelnodeBasicAddress ? bitcoin.address.fromBase58Check(zelnodeBasicAddress).hash : null
			let zelnodeSuperAddrHash = zelnodeSuperAddress ? bitcoin.address.fromBase58Check(zelnodeSuperAddress).hash : null
			let zelnodeBamfAddrHash = zelnodeBamfAddress ? bitcoin.address.fromBase58Check(zelnodeBamfAddress).hash : null

			extraPosition = 1;
			poolOutputAmount = Math.round(blockReward.total * (1 - (feePercent / 100))) + feeReward - zelnodeBasicAmount - zelnodeSuperAmount - zelnodeBamfAmount;

			if (zelnodeBasicAddrHash != null) {
				extraOutputs.push({
					script: scriptCompile(zelnodeBasicAddrHash),
					address: null,
					amount: Math.round(zelnodeBasicAmount)
				});
			}
			
			if (zelnodeSuperAddrHash != null) {
				extraOutputs.push({
					script: scriptCompile(zelnodeSuperAddrHash),
					address: null,
					amount: Math.round(zelnodeSuperAmount)
				});
			}
			
			if (zelnodeBamfAddrHash != null) {
				extraOutputs.push({
					script: scriptCompile(zelnodeBamfAddrHash),
					address: null,
					amount: Math.round(zelnodeBamfAmount)
				});
			}
		}
	}
	if (poolOutputAmount === 0) {
		if (coin.symbol === "EGC") {
			charityAmount = (available * 2) / 100;
			charityAddress = charityAddress? charityAddress : "EdFwYw4Mo2Zq6CFM2yNJgXvE2DTJxgdBRX";
			extraOutputs.push({
				'address': charityAddress,
				'amount': charityAmount, // 2 percent charity fee.
			});
			available -= Math.round(charityAmount);
		}
		else if (coin.symbol === "LINX") {
			extraPosition = 1;
			const COIN = 100000000;
			if (rpcData.height <= 315001)
				charityAmount = 0;
			else if (rpcData.height <= 500000)
				charityAmount = 2.5 * COIN;
			else if (rpcData.height <= 2000000)
				charityAmount = 1.25 * COIN;
			else if (rpcData.height <= 3500000)
				charityAmount = 0.5 * COIN;
			else if (rpcData.height <= 7007152)
				charityAmount = 0.25 * COIN;
			else
				charityAmount = 0;
			charityAddress = charityAddress? charityAddress : "XF7kCcs4woQD9WWnCHuN6SWPeUNK2fBspr";
			extraOutputs.push({
				'address': charityAddress,
				'amount': charityAmount,
			})
			available -= Math.round(charityAmount);
		}
		else if (coin.symbol === "SIN" && rpcData.payee) {
			extraPosition = 1;
			charityAddress = rpcData.payee;
			charityAmount= rpcData.payee_amount;
			if (charityAddress && charityAmount) {
				extraOutputs.push({
					'address': charityAddress,
					'amount': charityAmount,
				})
				available -= Math.round(charityAmount);
			}
			if (rpcData.masternode_payments_started && Array.isArray(rpcData.masternode)) for (let i = 0; i < rpcData.masternode.length; i++) {
				extraOutputs.push({
					'address': rpcData.masternode[i].payee,
					'amount': rpcData.masternode[i].amount,
				})
				available -= Math.round(rpcData.masternode[i].amount);
			}
		}
		else if (coin.symbol === "DYN" && (rpcData.dynode_payments_enforced || rpcData.superblocks_enabled) && rpcData.dynode) { // dynode_payments item will require old type of masternodes instead of below solution.
			if (rpcData.superblocks_enabled && Array.isArray(rpcData.superblock)) for (let i = 0; i < rpcData.superblock.length; i++) {
				extraOutputs.push({
					'address': rpcData.superblock[i].payee,
					'amount': rpcData.superblock[i].amount,
				})
				available -= Math.round(rpcData.superblock[i].amount);
			}
			if (rpcData.dynode_payments_enforced && rpcData.dynode_payments_started && rpcData.dynode.payee && rpcData.dynode.amount) {
				extraOutputs.push({
					'address': rpcData.dynode.payee,
					'amount': rpcData.dynode.amount,
				})
				available -= Math.round(rpcData.dynode.amount);
			}
		}
		else if (coin.symbol === "LTCR") {
			charityAmount = (available * 10) / 100;
			charityAddress = charityAddress? charityAddress : "BCDrF1hWdKTmrjXXVFTezPjKBmGigmaXg5";
			extraOutputs.push({
				'address': charityAddress,
				'amount': charityAmount, // 2 percent charity fee.
			});
			available -= Math.round(charityAmount);
		}
		else if (coin.symbol === "XZC") {
			charityAmount = (available * 25) / 100;
			charityAddress = charityAddress? charityAddress : "aHu897ivzmeFuLNB6956X6gyGeVNHUBRgD";
			// strcat(templ->coinb2, "06");
			extraOutputs.push({
				'address': "aCAgTPgtYcA4EysU4UKC86EQd5cTtHtCcr",
				'amount': charityAmount/5, // 1/5 of charity fee.
			});
			extraOutputs.push({
				'address': charityAddress,
				'amount': charityAmount/5, // 1/5 of charity fee.
			});
			extraOutputs.push({
				'address': "aQ18FBVFtnueucZKeVg4srhmzbpAeb1KoN",
				'amount': charityAmount/5, // 1/5 of charity fee.
			});
			extraOutputs.push({
				'address': "a1HwTdCmQV3NspP2QqCGpehoFpi8NY4Zg3",
				'amount': charityAmount/5, // 1/5 of charity fee.
			});
			extraOutputs.push({
				'address': "a1kCCGddf5pMXSipLVD9hBG2MGGVNaJ15U",
				'amount': charityAmount/5, // 1/5 of charity fee.
			});
			available -= Math.round(charityAmount);
		}
		
		poolOutputAmount = Math.round(available);
	}
	
	if (poolOutputAmount === 0) poolOutputAmount = Math.round(available);
	
	if (extraOutputs.length === 0 || extraOutputs.length === undefined) {
		if (rpcData.masternode && rpcData.superblock) {
			if (rpcData.masternode.payee) {
				extraOutputs.push({
					script: null,
					address: rpcData.masternode.payee,
					amount: rpcData.masternode.amount
				});
				poolOutputAmount -= Math.round(rpcData.masternode.amount);
			} else if (rpcData.superblock.length > 0)
				for(var i in rpcData.superblock){
					extraOutputs.push({
						script: null,
						address: rpcData.superblock[i].payee,
						amount: rpcData.superblock[i].amount
					});
					poolOutputAmount -= Math.round(rpcData.superblock[i].amount);
				}
		}

		if (rpcData.payee) {
			extraOutputs.push({
				script: null,
				address: rpcData.payee,
				amount: rpcData.payee_amount? rpcData.payee_amount : Math.ceil(rpcData.coinbasevalue / 5)
			});
			poolOutputAmount -= Math.round(rpcData.payee_amount? rpcData.payee_amount : Math.ceil(rpcData.coinbasevalue / 5));
		}
	}
	
	if (recipientsAmount !== 0) poolOutputAmount = Math.round(poolOutputAmount-recipientsAmount);
	
	let combinedTxs = []
	combinedTxs.push({
		script: scriptCompile(poolAddrHash),
		amount: poolOutputAmount
	});
	
	if (extraOutputs.length > 0) {
		for (let i = 0; i < extraOutputs.length; i++) {
			if (extraPosition === 0) combinedTxs.unshift({
				script: (extraOutputs[i].script === undefined || extraOutputs[i].script === null)? 
				scriptCompile(bitcoin.address.fromBase58Check(extraOutputs[i].address).hash) : extraOutputs[i].script,
				amount: extraOutputs[i].amount
			})
			else if (extraPosition === 1) combinedTxs.push({
				script: (extraOutputs[i].script === undefined || extraOutputs[i].script === null)? 
				scriptCompile(bitcoin.address.fromBase58Check(extraOutputs[i].address).hash) : extraOutputs[i].script,
				amount: extraOutputs[i].amount
			})
		}
	}
	
	if (recipientsOutputs.length > 0) for (let i = 0; i < recipientsOutputs.length; i++)
		combinedTxs.push({
			script: (recipientsOutputs[i].script === undefined || recipientsOutputs[i].script === null)? 
			scriptCompile(bitcoin.address.fromBase58Check(recipientsOutputs[i].address).hash) : recipientsOutputs[i].script,
			amount: recipientsOutputs[i].amount
		})
	
	let tx;
	
	if (txb !== null) { // using bitgo-utxo-lib to generate transactions!
		// Segwit support
		if (rpcData.default_witness_commitment !== undefined) {
			txb.addOutput(new Buffer(rpcData.default_witness_commitment, 'hex'), 0);
		}
		for (let i = 0; i < combinedTxs.length; i++)
			txb.addOutput(
				combinedTxs[i].script,
				Math.round(combinedTxs[i].amount)
			);
		tx = txb.build() // build tx
		txHex = tx.toHex()
		txHash = tx.getHash().toString('hex')
    	// console.log('hex coinbase transaction: ' + txHex)
		return txHex
	}
	
	// if txb is not in use.
	let txOutputBuffers = [];
	let outputTransactions;
	for (let i = 0; i < combinedTxs.length; i++) {
		txOutputBuffers.push(Buffer.concat([
			util.packInt64LE(Math.round(combinedTxs[i].amount)),
			util.varIntBuffer(combinedTxs[i].script.length),
			combinedTxs[i].script
		]));
	}
	if (rpcData.default_witness_commitment !== undefined){
        witness_commitment = new Buffer(rpcData.default_witness_commitment, 'hex');
        txOutputBuffers.unshift(Buffer.concat([
            util.packInt64LE(0),
            util.varIntBuffer(witness_commitment.length),
            witness_commitment
        ]));
    }
	
	outputTransactions = Buffer.concat([
        util.varIntBuffer(txOutputBuffers.length),
        Buffer.concat(txOutputBuffers)
    ]);
	
	p2 = Buffer.concat([
        scriptSigPart2,
        util.packUInt32LE(txInSequence),
        //end transaction input

        //transaction output
        outputTransactions,
        //end transaction ouput

        util.packUInt32LE(txLockTime),
        txComment
    ]);

    if (txExtraPayload !== undefined) {
        p2 = Buffer.concat([
            p2,
            util.varIntBuffer(txExtraPayload.length),
            txExtraPayload
        ]);
    }

    return [p1, p2];
}

module.exports.getFees = feeArray => {
    let fee = Number()
    feeArray.forEach(value => fee += Number(value.fee))
    return fee
}