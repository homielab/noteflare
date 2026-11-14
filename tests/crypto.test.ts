import { describe, expect, it } from 'vitest'
import {
  createVault, decryptNote, encryptNote, normalizeRecoveryCode, rewrapVault,
  unlockWithPassphrase, unlockWithRecovery, UnsafeKdfError, WrongSecretError,
} from '../src/lib/crypto'

const id = '3f2b8c1e-1234-4abc-9def-0123456789ab'
const note = { title: 'Xin chào', body: '- [ ] việc 1\n- [x] việc 2', color: 'sage' as const, labels: ['nhà'] }

describe('vault', () => {
  it('round-trips with passphrase and recovery code; rejects wrong secrets', async () => {
    const { record, dek, recoveryCode } = await createVault('ngựa đúng pin kẹp giấy')
    expect(record.version).toBe(0)
    expect(recoveryCode).toMatch(/^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/)
    expect(dek.extractable).toBe(false)

    const enc = await encryptNote(dek, id, note)
    const viaPass = await unlockWithPassphrase(record, 'ngựa đúng pin kẹp giấy')
    expect(await decryptNote(viaPass, id, enc.ciphertext, enc.iv)).toEqual(note)

    const viaRecovery = await unlockWithRecovery(record, recoveryCode.toLowerCase().replace(/-/g, ' '))
    expect(await decryptNote(viaRecovery, id, enc.ciphertext, enc.iv)).toEqual(note)

    await expect(unlockWithPassphrase(record, 'sai rồi')).rejects.toBeInstanceOf(WrongSecretError)
    await expect(unlockWithRecovery(record, 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA')).rejects.toBeInstanceOf(WrongSecretError)
  }, 30_000)

  it('binds ciphertext to note id (AAD)', async () => {
    const { dek } = await createVault('pass-1')
    const enc = await encryptNote(dek, id, note)
    await expect(decryptNote(dek, id.replace('3f', '4f'), enc.ciphertext, enc.iv)).rejects.toThrow()
  }, 30_000)

  it('rewraps without re-encrypting notes', async () => {
    const { record, dek, recoveryCode } = await createVault('old pass')
    const enc = await encryptNote(dek, id, note)
    const { record: next } = await rewrapVault(record, { recoveryCode }, 'new pass')
    expect(next.recoveryDek).toBe(record.recoveryDek)
    await expect(unlockWithPassphrase(next, 'old pass')).rejects.toBeInstanceOf(WrongSecretError)
    const k = await unlockWithPassphrase(next, 'new pass')
    expect((await decryptNote(k, id, enc.ciphertext, enc.iv)).title).toBe('Xin chào')
  }, 30_000)

  it('refuses weak KDF params from server', async () => {
    const { record } = await createVault('p')
    await expect(unlockWithPassphrase({ ...record, kdf: { ...record.kdf, memoryKiB: 8 } }, 'p')).rejects.toBeInstanceOf(UnsafeKdfError)
    // Absurd settings would freeze or crash the device; refuse them before deriving anything.
    await expect(unlockWithPassphrase({ ...record, kdf: { ...record.kdf, memoryKiB: 4 * 1024 * 1024 } }, 'p')).rejects.toBeInstanceOf(UnsafeKdfError)
    await expect(unlockWithPassphrase({ ...record, kdf: { ...record.kdf, iterations: 1e6 } }, 'p')).rejects.toBeInstanceOf(UnsafeKdfError)
    await expect(unlockWithPassphrase({ ...record, kdf: { ...record.kdf, parallelism: 64 } }, 'p')).rejects.toBeInstanceOf(UnsafeKdfError)
    await expect(unlockWithPassphrase({ ...record, kdf: { ...record.kdf, iterations: 2.5 } }, 'p')).rejects.toBeInstanceOf(UnsafeKdfError)
  }, 30_000)

  it('normalizes ambiguous recovery characters', () => {
    expect(normalizeRecoveryCode('o1l-i')).toBe('0111')
  })
})
