# Instrumentation and the target app share stdlib classes; keep their ABI in
# the test-only minified variant. Production release uses its normal R8 rules.
-keep class kotlin.** { *; }
-keep class kotlinx.coroutines.** { *; }
-keep class androidx.compose.ui.** { *; }
-keep class androidx.compose.runtime.** { *; }
-keep class androidx.compose.foundation.** { *; }
-keep class androidx.compose.animation.** { *; }
-keep class androidx.lifecycle.** { *; }
-keep class androidx.activity.** { *; }
-keep class com.google.common.** { *; }
-keep class com.google.common.** { *; }
-keep class kotlinx.coroutines.** { *; }
