# BE 11.0.3 provenance supplement

The verified BE 11.0.3 archive is available for the root-owned release ladder test:

`.parity/consumers/be-release-audit/downloads/jibo-be-11.0.3.tar.gz`

It is 200,018,128 bytes with SHA-256 `64690ab4f99b717cf49768993f7a750e8df4746a2a96179cd0a54f575190dc41`. The source recovery is selective; the full archive was not unpacked. The recovered manifest is [`.parity/consumers/be-release-audit/sources/11.0.3/manifest.json`](../../../../../.parity/consumers/be-release-audit/sources/11.0.3/manifest.json), 56,197 bytes, SHA-256 `25a61cb8ad3e4dd7a4cde90aa98e26336cd5466cfa130f96646be1545fa335d3`.

## Selected archive members

The following are the package manifest, compiled bundle, and source-map hashes recovered directly from the archive:

| Package | Version | Package manifest SHA-256 | Compiled JS SHA-256 | Source map SHA-256 |
| --- | --- | --- | --- | --- |
| `@be/be` | 11.0.3 | `eeef85892c67ed487f3d1299582d6d2fa014ad8c5495ffff655545f91f8bb57d` | `ec00118360299001a6c8b6a56a322cc3bb742a6e320072e6e5ee7c24ea28e3da` | `28d92b3f4dbfc7e7fa7c2911b11162afc8d964e06ba59b12473c0fcc68e3aa87` |
| `@be/nimbus` | 3.0.3 | `05d4452bc03512a546a0333cea703f72becc883c2d291315416d9b21ecae60f0` | `59fcc567686966d6d99f724bd217dc1c1cebee33e03f58bd3db2ed6763ea0f93` | `5d935addf94ffbf590cd1fa1fe28fef4af8fddbf79756fa7cf7ce54d61865b73` |
| `@be/be-framework` | 12.0.3 | `e0318d88ca4a0ce8881152ee8cee2bea0c18abb002918e1af154298aad70d34d` | `effc717d41fd747f8d182bf9fb0d5f0505489e115c90791a79bf705a0f2ed1d7` | `2106ea4a13353fed24657db669267c56a1f10cc0c665b42eb65f13b1cb040d3f` |
| `@jibo/jetstream-client` | 3.0.3 | `f61935e89613fa420ca39e80bcb94c1ea857796a46683744926848922b56dbb7` | `a6c8d75e1772c0b8f03877cab17d899708385249260e6b3ff2e75115ab23e982` | `907d1dc7f2d63b7d54ae8ec4bce8612fa16eba161ccc29a1f441ec2171ea2b29` |
| `jibo` | 15.0.3 | `f970d46782200e99188d0e2640a3f7c3b0164cdfe3b397959d0d2b3ea0ade695` | `ba4c72b8127e311d6aaf5c4308e624182fd80e0e7aca13e37c66e88cec3f89cb` | `1d1777c39d951814974cb8aa852ddf3c61784322949a1baee44cd66daa80629f` |
| `jibo-embodied-dialog` | 9.0.3 | `7dc5166b41ccf0c9f74d0af0e9e92f92f2e4e8e1779ead1029043b69f607632e` | `eb5d207f09b8c5f10d383906732ebad5c97e632650be21c939d63e1c6b5d2433` | `ebe5ddf7ec9461b7f35df9f556b225b74eb0d677b0fad078674725a869404689` |
| `jibo-action-system` | 8.0.3 | `df01ee7b1523aa7fa86d5a38bca4e8655c65e6d20dbf5df8dec18edfd32857e7` | `593bb5ac5d9575d7b611ac763b0263ca5094becc7ec18b74b348ad5e07b3fb54` | `61aad74b938a3b94938d64c178d6851807087ec76bc740deeb24fcf610f89a47` |

The `jibo-embodied-dialog` source map has 67 embedded sources; all 67 include content and 65 `src/` files were recovered. `src/listen/EmbodiedListen.ts` is 23,469 bytes, SHA-256 `46f35e53cc4b7ff75164aaca5bb12a9afdc9048239fb86b5f3295deb9f5a6b83`. Its compiled bundle ends with `//# sourceMappingURL=jibo-embodied-dialog.js.map`, and the archive-level compiled bundle and map are byte-identical to BE 11.0.2 and BE 12.0.0. The source-map `sourcesContent` for `src/listen/EmbodiedListen.ts` hashes to the recovered source file above.

Compiled active-code inspection confirms the source boundary:

| Release | Compiled bundle | HJ expression in compiled JS |
| --- | --- | --- |
| 11.0.1 | 262,942 bytes, SHA-256 `691bd39629413cac8c814d887b19ea28c2dcbb6a5a2b254668cb1f0c7fbbff06` | `setLED(...Led.LISTENING); this.startListeningEye(true);` |
| 11.0.2 | 260,350 bytes, SHA-256 `eb5d207f09b8c5f10d383906732ebad5c97e632650be21c939d63e1c6b5d2433` | `setLED(...Led.OFF);` with no active `startListeningEye` |
| 11.0.3 | 260,350 bytes, same SHA-256 as 11.0.2 | Same disabled code |
| 12.0.0 | 260,350 bytes, same SHA-256 as 11.0.2/11.0.3 | Same disabled code |

The 11.0.1, 11.0.2, 11.0.3, and 12.0.0 compiled action-system bundles are also byte-identical: 213,317 bytes, SHA-256 `593bb5ac5d9575d7b611ac763b0263ca5094becc7ec18b74b348ad5e07b3fb54`. Their source maps are identical at SHA-256 `61aad74b938a3b94938d64c178d6851807087ec76bc740deeb24fcf610f89a47`.

## Action-system configuration boundary

The action-system package manifest, rather than its compiled source, changes the proactive runtime setup:

| BE | Action-system | Manifest SHA-256 | `pegasusProactiveTrigger` | `disableProactiveTrigger` |
| --- | --- | --- | --- | --- |
| 11.0.1 | 8.0.1 | `02746fc7784aba5614502a2b824672a1c742a87b423d655e394f676333c2690f` | `true` | `false` |
| 11.0.2 | 8.0.2 | `6c97215a49a338cf84791e0f51a9a94c1c4d1419efdfada35091f598ab6dba78` | `false` | `false` |
| 11.0.3 | 8.0.3 | `df01ee7b1523aa7fa86d5a38bca4e8655c65e6d20dbf5df8dec18edfd32857e7` | `false` | `false` |
| 12.0.0 | 8.0.4 | `350a1d47301d4acc1d92d756b5298db223eccd2db5055ab71561afe50c62f45b` | `false` | `false` |

The same source is present in the 11.0.3 map: `src/common/ActionRuntime.ts` SHA-256 `d759fbca32661417b1ef17a90edcd739dde48584624dfbdbcdf4e4dd5803d2fb` reads the package options at lines 43–57. At lines 142–155 it creates `this.proactive` only when `pegasusProactiveTrigger` is true; otherwise it creates the older `ProactiveGreetingGoalProvider` and leaves `proactive` null. `src/api.ts` SHA-256 `cdc643ba27599af29827ecabad178854d9e2bbed110564ce9be39f1a6aea8aa4` unconditionally calls `_runtime.proactive.checkEnvironmentInhibitors()` at lines 232–234.

This explains the observed `checkEnvironmentInhibitors`-of-null error as a configuration/source-contract mismatch introduced at the 11.0.1 -> 11.0.2 package boundary. It does not explain the blue-ring loss, which is the separate `jibo-embodied-dialog` source change. Do not patch the robot for this audit; root can use BE 11.0.1 as the controlled comparison and decide whether the production configuration should initialize the proactive detector.
