# Fleet Intelligence DEV working guidance

Read the [CST Global Development SOP](https://github.com/Travelintrips/Core-AI-Foundation/blob/develop/CST-GLOBAL-DEVELOPMENT-SOP.md) before classifying a job. Record its version and source commit with the Fleet commit and verification evidence.

Reuse existing CSV ingestion, reconciliation, WhatsApp, and Finance integration paths. Verify company scope and use DEV fixtures or sanitized input. Test import replay for duplicate transactions and verify the target company before testing a Finance handoff. Use isolated destinations in automated messaging tests. Preserve the independently authorized manual send path and the existing scheduled delivery behavior.

Use Fleet CI and the existing DEV workflow where applicable. Record the actual DEV runtime SHA and results separately from CI. Production changes require explicit owner approval.
