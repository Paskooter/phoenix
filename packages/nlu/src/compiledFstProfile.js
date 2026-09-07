// The only compiled graph profile currently accepted by the NLU runtime.
// Snapshot manifests repeat these values so a JSON data bundle cannot silently
// become an arbitrary alternate grammar profile.
export const COMPILED_FST_PROFILE = Object.freeze({
  runtime: 'compiled-fst',
  approvedLaunchSha256: '2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a',
  approvedInventorySha256: '4377949617eb3169f1466ddb2844f2f5f9948f43e1942a2e35f38c3664dc4aa5',
  sourceRevision: '91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e',
  referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
  sourceRuntime: 'jibo-nlu v2.8.3',
  nativeParserSha256: '373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b',
  factoryManifestSha256: '4ea19a27acbfaecdb60de0688cb5f3f75ef31c93c2865d2d6710989f98ffe97e',
  factoryFiles: Object.freeze({
    'canada_city_province.fst': '3f51276ae65825ab22aa0ebba97766e5fdea055e6db7d89ce9e77e9195cf5076',
    'canada_province.fst': 'd671f80c98845fdd9a29dc6cf381689a9d42119a82d376c4f05d278f7e07eaea',
    'city_state.fst': 'e42af10ecb18f487b639290f60d83677f9c9b0294201add41983d3ba6f587d7e',
    'country.fst': '0ee7a77ac8d64bedde7416954929ff9ae33bab9946e897f13841dcffda68791c',
    'date.fst': 'fbcaa68a5c7c2b32ba6cb844e9696b1e6cb8a23e251f3fdacb0981110ff2d7c8',
    'digits.fst': 'e32543cebaef266f65e03ff8458f8b5278c37573f245d0efbf427457a59c5831',
    'factory_list.txt': '95a7fb321148ff4e851354f8e564524a4c3f282aed38d60f5c7e9fe24614ab78',
    'first_name.fst': '3fb01bdf8c39aa4bbf1d7eaa2e74da880faeb30b714db506fd62b4eb624b2056',
    'last_name.fst': '19862ddaa95bca44582eb811b7235370c5d291efcc21ce7c5f43027ca44ac66c',
    'music_genre.fst': '045a4171e0b74c18d75a05dca017ef5ed99c831970e43de78f5ceed780d4bb2c',
    'state.fst': 'b9ed3ebb1cd8c13117642743cca71616e1774801ec9b85ebdeea79aced6fb862',
    'time.fst': 'ccc50d3c0fb06e43e75433fa828d370c787429a443bfa407c6e91be73cd9d86b',
    'timer.fst': 'b499a09296f1d5ca2429c191d81f80b0e2f73044da1801d09fd89010b6aefa3e',
    'world_city_country.fst': '08738ae15c69785f593c0f2024d25e10292831c6e0fbe8961efadb2e3a2ea0f3',
    'year.fst': 'a7306d576b909940f506d4151a800d900b95f943da2d5901bc0db987a61d3cbc',
    'yes_no.fst': '8e86171f2758430610f487640fdbc4c23b2e2f04c2b5cc5446e875972de67fa4',
  }),
});

export const FST_PROFILE_SCHEMA = 'phoenix.nlu.compiled-fst-profile';
export const FST_PROFILE_VERSION = 1;
