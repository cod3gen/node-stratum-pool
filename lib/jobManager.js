var events = require('events');
var crypto = require('crypto');

var bignum = require('bignum');

var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');
var equiBlockTemplate = require('./equiBlockTemplate.js');

var vh = require('verushash');

const EH_PARAMS_MAP = {
    "144_5": {
        SOLUTION_LENGTH: 202,
        SOLUTION_SLICE: 2,
    },
    "192_7": {
        SOLUTION_LENGTH: 806,
        SOLUTION_SLICE: 6,
    },
    "200_9": {
        SOLUTION_LENGTH: 2694,
        SOLUTION_SLICE: 6,
    }
}

//Unique extranonce per subscriber
var ExtraNonceCounter = function (configInstanceId) {
    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = instanceId << 27;
    this.next = function () {
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };
    this.size = 4; //bytes
};

//Unique job per new block template
var JobCounter = function () {
    var counter = 0x0000cccc;

    this.next = function () {
        counter++;
        if (counter % 0xffffffffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};

function isHexString(s) {
    var check = String(s).toLowerCase();
    if(check.length % 2) {
        return false;
    }
    for (i = 0; i < check.length; i=i+2) {
        var c = check[i] + check[i+1];
        if (!isHex(c))
            return false;
    }
    return true;
}

function isHex(c) {
    var a = parseInt(c,16);
    var b = a.toString(16).toLowerCase();
    if(b.length % 2) {
        b = '0' + b;
    }
    if (b !== c) {
        return false;
    }
    return true;
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
 **/
var JobManager = module.exports = function JobManager(options) {


    //private members

    var _this = this;
    var jobCounter = new JobCounter();

    var shareMultiplier = algos[options.coin.algorithm].multiplier;

    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
    this.extraNoncePlaceholder = new Buffer('f000000ff111111f', 'hex');
    this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;

    this.currentJob;
    this.validJobs = {};

    var hashDigest = algos[options.coin.algorithm].hash(options.coin);

    var coinbaseHasher = (function(){
        switch(options.coin.algorithm){
            case 'keccak':
            case 'blake':
            case 'fugue':
            case 'groestl':
                if (options.coin.normalHashing === true)
                    return util.sha256d;
                else
                    return util.sha256;
            default:
                return util.sha256d;
        }
    })();


    var blockHasher = (function () {
        switch (options.coin.algorithm) {
            case 'scrypt':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-jane':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-n':
            case 'sha1':
            case 'equihash':
            case 'verus':
                return function (d) {
                    return util.reverseBuffer(util.sha256d(d));
                };
            default:
                return function () {
                    return util.reverseBuffer(hashDigest.apply(this, arguments));
                };
        }
    })();
    function buildMerkleTree(auxData) {
        // Determine which slots the merkle hashes will go into in the merkle tree
        // Strategy derived from p2pool
        var size = 1;
        for(;size < Math.pow(2, 32);size *= 2) {
            if(size < auxData.length)
                continue;
            var res = new Array(size);
            for(var i = 0;i < size;i++)
                res[i] = new Buffer(32);
            var c = [];
            for(var i = 0;i < auxData.length;i++) {
                var pos = util.getAuxMerklePosition(auxData[i].chainid, size);
                if(c.indexOf(pos) != -1)
                    break;
                c.push(pos);
                var d = util.uint256BufferFromHash(auxData[i].hash);
                d.copy(res[pos]);
            }
            if(c.length == auxData.length) {
                // all coins added successfully to the tree, return a generated merkle tree
                var auxMerkleTree = new merkleTree(res);
                return auxMerkleTree;
            }
        }
    }
	
	this.updateCurrentJob = function (rpcData) {
		const auxMerkleTree = buildMerkleTree(rpcData.auxes);
		let tmpBlockTemplate = new blockTemplate(
			jobCounter.next(),
			rpcData,
			_this.extraNoncePlaceholder,
			options.recipients,
			options.address,
			options.poolHex,
			options.coin,
			auxMerkleTree
		);

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        _this.auxMerkleTree = auxMerkleTree;

    };

    //returns true if processed a new block
    this.processTemplate = function (rpcData) {

        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
           block height is greater than the one we have */
        let isNewBlock = typeof(_this.currentJob) === 'undefined';
        if (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }

        if (!isNewBlock) return false;
		
		const auxMerkleTree = buildMerkleTree(rpcData.auxes);
		let tmpBlockTemplate = new blockTemplate(
			jobCounter.next(),
			rpcData,
			_this.extraNoncePlaceholder,
			options.recipients,
			options.address,
			options.poolHex,
			options.coin,
			auxMerkleTree
		);

        this.currentJob = tmpBlockTemplate;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        this.auxMerkleTree = auxMerkleTree;

        return true;

    };

    this.processShare = function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln) {
        var shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return {error: error, result: null};
        };
		
		this.isZ = util.isZ(options.coin);

        //console.log('processShare ck1: ', jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln)

        var submitTime = Date.now() / 1000 | 0;

		if (this.isZ)
			if (extraNonce2.length / 2 !== _this.extraNonce2Size)
				return shareError([20, 'incorrect size of extranonce2']);

        var job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId != jobId) {
            // console.log('job not found');
            return shareError([21, 'job not found']);
        }

        if (nTime.length !== 8) {
            // console.log('incorrect size of ntime');
            return shareError([20, 'incorrect size of ntime']);
        }

        //console.log('processShare ck2')
		
		var nTimeInt = (this.isZ)? parseInt(nTime, 16) : parseInt(util.reverseBuffer(new Buffer(nTime, 'hex')), 16);
        if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
            // console.log('ntime out of range');
            return shareError([20, 'ntime out of range']);
        }

        //console.log('processShare ck3')

		if (nonce.length !== 64 && this.isZ) {
            // console.log('incorrect size of nonce');
            return shareError([20, 'incorrect size of nonce']);
        } else if (nonce.length !== 8) {
            return shareError([20, 'incorrect size of nonce']);
        }
		
		/**
         * TODO: This is currently accounting only for equihash. make it smarter.
         */
        let parameters = options.coin.parameters
        if (!parameters) {
            parameters = {
                N: 200,
                K: 9,
                personalization: 'ZcashPoW'
            }
        }

        let N = parameters.N || 200
        let K = parameters.K || 9
        let expectedLength = EH_PARAMS_MAP[`${N}_${K}`].SOLUTION_LENGTH || 2694
        let solutionSlice = EH_PARAMS_MAP[`${N}_${K}`].SOLUTION_SLICE || 0
		
		if (soln.length !== expectedLength && this.isZ) {
            // console.log('Error: Incorrect size of solution (' + soln.length + '), expected ' + expectedLength);
            return shareError([20, 'Error: Incorrect size of solution (' + soln.length + '), expected ' + expectedLength]);
        }

        if (!isHexString(extraNonce2)) { // !!CHK!! This may cause issue on algos other than verus and equi
            // console.log('invalid hex in extraNonce2');
            return shareError([20, 'invalid hex in extraNonce2']);
        }

        //console.log('processShare ck4')
		
		if (!job.registerSubmit(extraNonce1, extraNonce2, nTime, nonce, header, soln)) {
			return shareError([22, 'duplicate share']);
		}
		
		//console.log('processShare ck5')

        var extraNonce1Buffer = new Buffer(extraNonce1, 'hex');
        var extraNonce2Buffer = new Buffer(extraNonce2, 'hex');
		var headerHash;
		var headerBuffer;
		var headerSolnBuffer;
		var coinbaseBuffer;
		var coinbaseHash;
		var merkleRoot;
		var blockHashInvalid;
        var blockHash;
        var blockHex;
		
		if (this.isZ) {
			headerBuffer = job.serializeHeader(nTime, nonce); // 144 bytes (doesn't contain soln)
			headerSolnBuffer = new Buffer.concat([headerBuffer, new Buffer(soln, 'hex')]);

			//console.log('processShare ck6 - equi')

			switch (options.coin.algorithm) {
				case 'verushash':
					//console.log('processShare ck6a, buffer length: ', headerSolnBuffer.length)
					headerHash = vh.hash(headerSolnBuffer);
					break;
				default:
					//console.log('processShare ck6b')
					headerHash = util.sha256d(headerSolnBuffer);
					break;
			};
		} else {
			coinbaseBuffer = job.serializeCoinbase(extraNonce1Buffer, extraNonce2Buffer);
			coinbaseHash = coinbaseHasher(coinbaseBuffer);

			merkleRoot = util.reverseBuffer(job.merkleTree.withFirst(coinbaseHash)).toString('hex');
			headerBuffer = job.serializeHeader(merkleRoot, nTime, nonce);
			headerHash = hashDigest(headerBuffer, nTimeInt);
		}
		
		//console.log('processShare ck7')
		
		var headerBigNum = bignum.fromBuffer(headerHash, {endian: 'little', size: 32});

        var shareDiff = this.isZ? equidiff1 : diff1 / headerBigNum.toNumber() * shareMultiplier;

        var blockDiffAdjusted = job.difficulty * shareMultiplier;

        //console.log('processShare ck8')
		
        //Check if share is a block candidate (matched network difficulty)
		
		if (this.isZ && headerBigNum.le(job.target)) {
			//console.log('begin serialization');
            blockHex = job.serializeBlock(headerBuffer, new Buffer(soln, 'hex')).toString('hex');
            blockHash = util.reverseBuffer(headerHash).toString('hex');
            //console.log('end serialization');
		}
		else if (!this.isZ && job.target.ge(headerBigNum)){
            blockHex = job.serializeBlock(headerBuffer, coinbaseBuffer).toString('hex');
            if (options.coin.algorithm === 'blake' || options.coin.algorithm === 'neoscrypt') {                
                blockHash = util.reverseBuffer(util.sha256d(headerBuffer, nTime)).toString('hex');
            }
            else {
            	blockHash = blockHasher(headerBuffer, nTime).toString('hex');
            }
        }
        else {
			//console.log('low difficulty share');
            if (options.emitInvalidBlockHashes)
				blockHashInvalid = util.reverseBuffer(util.sha256d(this.isZ?headerSolnBuffer:headerBuffer)).toString('hex');

            //Check if share didn't reached the miner's difficulty)
            if (shareDiff / difficulty < 0.99){

                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty){
                    difficulty = previousDifficulty;
                }
                else{
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }

            }
        }

        /*
        console.log('validSoln: ' + hashDigest(headerBuffer, new Buffer(soln.slice(6), 'hex')));
        console.log('job: ' + jobId);
        console.log('ip: ' + ipAddress);
        console.log('port: ' + port);
        console.log('worker: ' + workerName);
        console.log('height: ' + job.rpcData.height);
        console.log('blockReward: ' + job.rpcData.reward);
        console.log('difficulty: ' + difficulty);
        console.log('shareDiff: ' + shareDiff.toFixed(8));
        console.log('blockDiff: ' + blockDiffAdjusted);
        console.log('blockDiffActual: ' + job.difficulty);
        console.log('blockHash: ' + blockHash);
        console.log('blockHashInvalid: ' + blockHashInvalid);
        */

        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
			workerPass: workerPass,
            height: job.rpcData.height,
            blockReward: this.isZ? job.rpcData.reward : job.rpcData.coinbasevalue,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid,
            time:submitTime // hashgoal addition for getblocksstats
        }, blockHex);

        return {result: true, error: null, blockHash: blockHash};
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
