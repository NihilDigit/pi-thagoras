package dev.nihildigit.pitato

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

fun encode64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
fun decode64(value: String): ByteArray = Base64.getDecoder().decode(value.replace('-', '+').replace('_', '/'))

/** The Ed25519 seed is encrypted with an installation-bound Android Keystore key. */
class Identity(context: Context) {
    private val privateKey: Ed25519PrivateKeyParameters
    val publicKey: String get() = encode64(privateKey.generatePublicKey().encoded)

    init {
        val preferences = context.getSharedPreferences("identity", Context.MODE_PRIVATE)
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "pitato.identity"
        val key = if (store.containsAlias(alias)) store.getKey(alias, null) as SecretKey else {
            check(!preferences.contains("seed")) { "Device key unavailable. Restore access to this Android installation." }
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            }.generateKey()
        }
        val saved = preferences.getString("seed", null)
        val seed = if (saved != null) {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, decode64(preferences.getString("iv", null)!!)))
            cipher.doFinal(decode64(saved))
        } else {
            ByteArray(32).also { bytes ->
                SecureRandom().nextBytes(bytes)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, key)
                check(preferences.edit().putString("seed", encode64(cipher.doFinal(bytes)))
                    .putString("iv", encode64(cipher.iv)).commit()) { "Could not save device identity" }
            }
        }
        privateKey = Ed25519PrivateKeyParameters(seed, 0)
        seed.fill(0)
    }

    fun sign(message: ByteArray): String = Ed25519Signer().run {
        init(true, privateKey)
        update(message, 0, message.size)
        encode64(generateSignature())
    }
}
