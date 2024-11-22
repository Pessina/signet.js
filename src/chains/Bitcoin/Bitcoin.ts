import axios from 'axios'
import * as bitcoin from 'bitcoinjs-lib'

import {
  fetchBTCFeeProperties,
  fetchDerivedBTCAddressAndPublicKey,
  parseBTCNetwork,
} from './utils'
import { type ChainSignatureContracts, type NearAuthentication } from '../types'
import { type KeyDerivationPath } from '../../kdf/types'
import {
  type BTCNetworkIds,
  type BTCTransaction,
  type UTXO,
  type BTCOutput,
  type Transaction,
  type BTCAddressInfo,
} from './types'
import { toRSV } from '../../signature/utils'
import { type RSVSignature, type MPCSignature } from '../../signature/types'

export class Bitcoin {
  private readonly network: BTCNetworkIds
  private readonly providerUrl: string
  private readonly contract: ChainSignatureContracts
  private readonly signer: (txHash: Uint8Array) => Promise<MPCSignature>

  constructor(config: {
    network: BTCNetworkIds
    providerUrl: string
    contract: ChainSignatureContracts
    signer: (txHash: Uint8Array) => Promise<MPCSignature>
  }) {
    this.network = config.network
    this.providerUrl = config.providerUrl
    this.contract = config.contract
    this.signer = config.signer
  }

  static toBTC(satoshis: number): number {
    return satoshis / 100000000
  }

  static toSatoshi(btc: number): number {
    return Math.round(btc * 100000000)
  }

  async fetchBalance(address: string): Promise<string> {
    const { data } = await axios.get<BTCAddressInfo>(
      `${this.providerUrl}/address/${address}`
    )
    return Bitcoin.toBTC(
      data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum
    ).toString()
  }

  async fetchTransaction(transactionId: string): Promise<bitcoin.Transaction> {
    const { data } = await axios.get<Transaction>(
      `${this.providerUrl}/tx/${transactionId}`
    )
    const tx = new bitcoin.Transaction()

    tx.version = data.version
    tx.locktime = data.locktime

    data.vin.forEach((vin) => {
      const txHash = Buffer.from(vin.txid, 'hex').reverse()
      const { vout, sequence } = vin
      const scriptSig = vin.scriptsig
        ? Buffer.from(vin.scriptsig, 'hex')
        : undefined
      tx.addInput(txHash, vout, sequence, scriptSig)
    })

    data.vout.forEach((vout) => {
      const { value } = vout
      const scriptPubKey = Buffer.from(vout.scriptpubkey, 'hex')
      tx.addOutput(scriptPubKey, value)
    })

    data.vin.forEach((vin, index) => {
      if (vin.witness && vin.witness.length > 0) {
        const witness = vin.witness.map((w) => Buffer.from(w, 'hex'))
        tx.setWitness(index, witness)
      }
    })

    return tx
  }

  static parseRSVSignature(signature: RSVSignature): Buffer {
    const r = signature.r.padStart(64, '0')
    const s = signature.s.padStart(64, '0')

    const rawSignature = Buffer.from(r + s, 'hex')

    if (rawSignature.length !== 64) {
      throw new Error('Invalid signature length.')
    }

    return rawSignature
  }

  async sendTransaction(txHex: string): Promise<string | undefined> {
    try {
      const response = await axios.post<string>(`${this.providerUrl}/tx`, txHex)

      if (response.status === 200) {
        return response.data
      }
      throw new Error(`Failed to broadcast transaction: ${response.data}`)
    } catch (error: unknown) {
      console.error(error)
      throw new Error(`Error broadcasting transaction`)
    }
  }

  async handleTransaction(
    data: BTCTransaction,
    nearAuthentication: NearAuthentication,
    path: KeyDerivationPath
  ): Promise<string> {
    const { address, publicKey } = await fetchDerivedBTCAddressAndPublicKey({
      signerId: nearAuthentication.accountId,
      path,
      btcNetworkId: this.network,
      nearNetworkId: nearAuthentication.networkId,
      multichainContractId: this.contract,
    })

    const { inputs, outputs } =
      data.inputs && data.outputs
        ? data
        : await fetchBTCFeeProperties(this.providerUrl, address, [
            {
              address: data.to,
              value: Bitcoin.toSatoshi(parseFloat(data.value)),
            },
          ])

    const psbt = new bitcoin.Psbt({
      network: parseBTCNetwork(this.network),
    })

    // Since the sender address is always P2WPKH, we can assume all inputs are P2WPKH
    await Promise.all(
      inputs.map(async (utxo: UTXO) => {
        const transaction = await this.fetchTransaction(utxo.txid)
        const prevOut = transaction.outs[utxo.vout]
        const value = utxo.value

        // Prepare the input as P2WPKH
        const inputOptions = {
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: prevOut.script,
            value,
          },
        }

        psbt.addInput(inputOptions)
      })
    )

    outputs.forEach((out: BTCOutput) => {
      if ('script' in out) {
        psbt.addOutput({
          script: out.script,
          value: out.value,
        })
      } else {
        psbt.addOutput({
          address: out.address || address,
          value: out.value,
        })
      }
    })

    const keyPair = {
      publicKey,
      sign: async (hash: Buffer): Promise<Buffer> => {
        const mpcSignature = await this.signer(hash)
        return Bitcoin.parseRSVSignature(toRSV(mpcSignature))
      },
    }

    // Sign inputs sequentially to avoid nonce issues
    for (let index = 0; index < inputs.length; index += 1) {
      await psbt.signInputAsync(index, keyPair)
    }

    psbt.finalizeAllInputs()
    const txid = await this.sendTransaction(psbt.extractTransaction().toHex())

    if (txid) {
      return txid
    }
    throw new Error('Failed to broadcast transaction')
  }
}
