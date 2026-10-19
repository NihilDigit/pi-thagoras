package dev.nihildigit.pitato

import androidx.test.platform.app.InstrumentationRegistry
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.junit.Assert.*
import org.junit.Test

class IdentityTest {
    @Test fun keystoreIdentitySurvivesReopeningAndSignsValidRelayChallenges() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val first = Identity(context)
        val reopened = Identity(context)
        assertEquals(first.publicKey, reopened.publicKey)
        assertEquals(32, decode64(first.publicKey).size)
        val challenge = ByteArray(32) { it.toByte() }
        val verifier = Ed25519Signer().apply {
            init(false, Ed25519PublicKeyParameters(decode64(first.publicKey), 0))
            update(challenge, 0, challenge.size)
        }
        assertTrue(verifier.verifySignature(decode64(reopened.sign(challenge))))
    }
}
