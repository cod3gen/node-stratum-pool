var bignum = require('bignum');

var merkleTree = require('./merkleTree.js');
var merkle = require('./equiMerkleTree.js');
var transactions = require('./transactions.js');
var util = require('./util.js');


/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin - txMessages, reward
**/ 
var BlockTemplate = module.exports = function BlockTemplate(
    jobId,
    rpcData,
    extraNoncePlaceholder,
    recipients,
    poolAddress,
    poolHex,
    coin,
    auxMerkleTree
) {
		
	//public members

    this.rpcData = rpcData;
    this.jobId = jobId;

    //private members

    var submits = [];
	this.isZ = util.isZ(coin);
		
	let blockReward = {
        'total': this.rpcData.miner !== undefined ? (this.rpcData.miner) * (coin.subsidyMultipleOfSatoshi || 100000000) : null,
		'coinbase': this.rpcData.coinbasevalue !== undefined ? this.rpcData.coinbasevalue : null
    };

    function getMerkleHashes(steps){
        return steps.map(function(step){
            return step.toString('hex');
        });
    }

    function getTransactionBuffers(txs){
        var txHashes = txs.map(function(tx){
            if (tx.txid !== undefined) {
                return util.uint256BufferFromHash(tx.txid);
            }
            return util.uint256BufferFromHash(tx.hash);
        });
        return [null].concat(txHashes);
    }

    function getVoteData(){
        if (!rpcData.masternode_payments) return new Buffer([]);

        return Buffer.concat(
            [util.varIntBuffer(rpcData.votes.length)].concat(
                rpcData.votes.map(function (vt) {
                    return new Buffer(vt, 'hex');
                })
            )
        );
    }

    var target = rpcData.target || rpcData._target;
    this.target = rpcData.target ?
        bignum(rpcData.target, 16) :
        util.bignumFromBitsHex(rpcData.bits);
		
	if (coin.payFoundersReward === true) {
        if (!this.rpcData.founders || this.rpcData.founders.length <= 0) {
            console.log('Error, founders reward missing for block template!');
        } else if (coin.payAllFounders){
            // SafeCash / Genx
            if (!rpcData.masternode_payments_started)
            {
                // Pre masternodes
                blockReward = {
                    "miner": (this.rpcData.miner),
                    "infrastructure": (this.rpcData.infrastructure),
                    "giveaways": (this.rpcData.giveaways),
                    "founderSplit": (this.rpcData.loki),
                    "total": (this.rpcData.miner + this.rpcData.founderstotal + this.rpcData.infrastructure + this.rpcData.giveaways)
                };
                //console.log(`SafeCash: ${this.rpcData.miner}`);
            }
            else
            {
                // console.log(this.rpcData);
                // Masternodes active
                blockReward = {
                    "miner": (this.rpcData.miner),
                    "infrastructure": (this.rpcData.infrastructure),
                    "giveaways": (this.rpcData.giveaways),
                    "founderamount": (this.rpcData.founderamount),
                    "total": (this.rpcData.coinbasevalue)
                };
            }
        } else {
            blockReward = {
                "total": (this.rpcData.miner + this.rpcData.founders + this.rpcData.securenodes + this.rpcData.supernodes) * 100000000
            };
        }
    }

    this.difficulty = parseFloat((this.isZ? equidiff1 : diff1 / this.target.toNumber()).toFixed(9));

	this.prevHashReversed = this.isZ ? util.reverseBuffer(new Buffer(rpcData.previousblockhash, 'hex')).toString('hex') : util.reverseByteOrder(new Buffer(rpcData.previousblockhash, 'hex')).toString('hex');
	this.hashReserved = rpcData.finalsaplingroothash? util.reverseBuffer(new Buffer(rpcData.finalsaplingroothash, 'hex')).toString('hex') : '0000000000000000000000000000000000000000000000000000000000000000';	
		
	this.merkleRoot = merkleTree.getRoot(rpcData, this.genTxHash);
	this.txCount = this.rpcData.transactions.length + 1; // add total txs and new coinbase
    this.merkleRootReversed = util.reverseBuffer(new Buffer(this.merkleRoot, 'hex')).toString('hex');
								 
    this.transactionData = Buffer.concat(rpcData.transactions.map(function(tx){
        return new Buffer(tx.data, 'hex');
    }));
    this.merkleTree = new merkleTree(util.getHashBuffers(rpcData.transactions.map(function(tx) {
        if (tx.txid !== undefined){
            return tx.txid;
        }
        return tx.hash;
    })));
    this.merkleBranch = getMerkleHashes(this.merkleTree.steps);
		
	var fees = [];
    rpcData.transactions.forEach(function(value) {
        fees.push(value);
    });
	this.rewardFees = transactions.getFees(fees);
    rpcData.rewardFees = this.rewardFees;

	if (typeof this.genTx === 'undefined') {
        this.genTx = transactions.createGeneration(
            rpcData,
			blockReward,
			recipients,
			poolAddress,
			poolHex,
			extraNoncePlaceholder,
			coin,
			auxMerkleTree
        ).toString('hex');
		this.genTxHash = transactions.txHash();
    }
		
	

    this.serializeCoinbase = function(extraNonce1, extraNonce2){
		return Buffer.concat([
			this.genTx[0],
			extraNonce1,
			extraNonce2,
			this.genTx[1]
		]);
	};


    //https://en.bitcoin.it/wiki/Protocol_specification#Block_Headers
    this.serializeHeader = function(merkleRoot, nTime, nonce){ // Changed!
		let header = this.isZ? new Buffer(140) : new Buffer(80);
		let position = 0;
		if (this.isZ) header.writeUInt32LE(this.rpcData.version, position += 0, 4, 'hex');
		else header.write(nonce, position, 4, 'hex');
		header.write(this.isZ ? this.prevHashReversed : this.rpcData.bits, position += 4, this.isZ ? 32 : 4, 'hex');
		header.write(this.isZ ? this.merkleRootReversed : nTime, this.isZ ? position += 32 : position += 4, this.isZ ? 32 : 4, 'hex');
		header.write(this.isZ ? this.hashReserved : merkleRoot, this.isZ ? position += 32 : position += 4, 32, 'hex');
		header.write(this.isZ ? nTime : this.rpcData.previousblockhash, position += 32, this.isZ ? 4 : 32, 'hex');
		if (this.isZ) header.write(util.reverseBuffer(new Buffer(rpcData.bits, 'hex')).toString('hex'), position += 4, 4, 'hex');
		else header.writeUInt32BE(rpcData.version, position + 32);
		if (this.isZ) header.write(nonce, position += 4, 32, 'hex');
		if (this.isZ) return header;
		else return util.reverseBuffer(header);
    };

    this.serializeBlock = function(header, coinbase, soln){
		let buf;
		if (!this.isZ)
        	buf = Buffer.concat([
				header,
				util.varIntBuffer(this.rpcData.transactions.length + 1),
				coinbase,
				this.transactionData,
				getVoteData(),
				//POS coins require a zero byte appended to block which the daemon replaces with the signature
				new Buffer(coin.reward === 'POS' ? [0] : [])
			]);
		else {
			var txCount = this.txCount.toString(16);
			if (Math.abs(txCount.length % 2) == 1) {
			  txCount = "0" + txCount;
			}

			if (this.txCount <= 0x7f){
				var varInt = new Buffer(txCount, 'hex');
			} else if (this.txCount <= 0x7fff) {
				if (txCount.length == 2) {
					txCount = "00" + txCount;
				}
				var varInt = new Buffer.concat([Buffer('FD', 'hex'), util.reverseBuffer(new Buffer(txCount, 'hex'))]);
			}

			buf = new Buffer.concat([
				header,
				soln,
				varInt,
				new Buffer(this.genTx, 'hex')
			]);

			if (this.rpcData.transactions.length > 0) {
				this.rpcData.transactions.forEach(function (value) {
					tmpBuf = new Buffer.concat([buf, new Buffer(value.data, 'hex')]);
					buf = tmpBuf;
				});
			}

			/*
			console.log('header: ' + header.toString('hex'));
			console.log('soln: ' + soln.toString('hex'));
			console.log('varInt: ' + varInt.toString('hex'));
			console.log('this.genTx: ' + this.genTx);
			console.log('data: ' + value.data);
			console.log('buf_block: ' + buf.toString('hex'));
			*/
			}
		return buf;
    };

	this.registerSubmit = function(extraNonce1, extraNonce2, nTime, nonce, header, soln){ // Changed!
		const submission = this.isZ ? (header + soln).toLowerCase() : extraNonce1 + extraNonce2 + nTime + nonce;
        if (submits.indexOf(submission) === -1){
            submits.push(submission);
            return true;
        }
        return false;
    };

    this.getJobParams = function(){
        if (!this.jobParams){
            this.jobParams = this.isZ? [
                this.jobId,
                util.packUInt32LE(this.rpcData.version).toString('hex'),
                this.prevHashReversed,
                this.merkleRootReversed,
                this.hashReserved,
                util.packUInt32LE(rpcData.curtime).toString('hex'),
                util.reverseBuffer(new Buffer(this.rpcData.bits, 'hex')).toString('hex'),
                true
            ] : [
                this.jobId,
                this.prevHashReversed,
                this.genTx[0].toString('hex'),
                this.genTx[1].toString('hex'),
                this.merkleBranch,
                util.packInt32BE(this.rpcData.version).toString('hex'),
                this.rpcData.bits,
                util.packUInt32BE(this.rpcData.curtime).toString('hex'),
                true
            ];
        }
        return this.jobParams;
    };
};
