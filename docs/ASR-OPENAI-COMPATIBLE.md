# Speech recognition through OpenRouter or your own speech server

Phoenix normally turns what people say to Jibo into text with Parakeet, a speech recognizer
you host yourself. It can also send each recording to:

- **OpenRouter**, which runs speech-to-text models from several companies, using the same
  OpenRouter key as Phoenix's other AI features; or
- **your own speech server**, any server that accepts the common OpenAI upload format
  (`POST /v1/audio/transcriptions`).

Either one can be the only recognizer, or a fallback that answers while Parakeet can't.
Everything below is done in the console under **Settings**, except one step on the server for
OpenRouter's usage file.

## Before you choose

- **Hints are not supported.** For each question Jibo sends a short list of words he expects,
  such as names in your household or "yes" and "no". Google uses that list. OpenRouter drops it
  without saying so, and the upload format your own server uses has no place for it, so Phoenix
  doesn't send it to either. Unusual names may be recognized less well than with Parakeet or
  Google.
- **Recordings leave your server.** With OpenRouter, each recording goes to OpenRouter and to
  the company that runs the chosen model. OpenRouter picks that company; Phoenix can't choose it.
- **It costs money.** OpenRouter bills per second of audio. Phoenix stops using it for the rest
  of the month when your monthly budget is used.
- **Speed hasn't been measured yet.** The recording is sent once the person stops talking, so
  the answer arrives a little after the end of speech. We expect well under a second for a short
  question, but have not measured it.

## Use OpenRouter

1. **Add the OpenRouter key.** Go to **Settings → Language models → OpenRouter key** and choose
   **Add…**. Paste the key from your OpenRouter account. If it is already set for Free AI chat,
   Jev or news, there is nothing to do: speech recognition uses the same key. There is no
   separate speech key. Give the key a spending limit in your OpenRouter account as well.
2. **Pick the model.** Go to **Settings → Speech recognition → OpenRouter speech model** and
   choose **Change…**. The list shows OpenRouter's speech-to-text models and, where OpenRouter
   prices them per second, the cost per hour of audio. Type to search. When you save, Phoenix
   checks the name with OpenRouter and refuses one that isn't a speech-to-text model. If
   OpenRouter can't be reached just then, the name is saved as you typed it and the setting
   says so.
3. **Set the monthly budget.** **OpenRouter speech monthly budget** starts at $2. With the
   default model that is about 33 hours of audio, or roughly 30,000 short questions. Set 0 to
   turn OpenRouter speech off. Under **More settings** there is also a daily budget; unset, it
   is one tenth of the month.
4. **Choose when it is used.** Under **Speech recognizer**, choose **OpenRouter** to use it for
   everything, or **Parakeet with fallback** to use it only while Parakeet can't answer. With
   the fallback, **Fallback order** says who comes next: OpenRouter then Google is the default.
5. **Create the usage file, once, on the server.** Phoenix counts what OpenRouter speech has
   cost in a file, and keeps OpenRouter speech off until that file exists, so a missing or
   damaged file can never mean unlimited spending. Run this once as the user Phoenix runs as:

   ```sh
   node scripts/init-openai-stt-usage.mjs "$PHOENIX_DATA_DIR/asr/openrouter-stt-usage.json"
   ```

   It refuses to replace a file that is already there. If you set
   `PHOENIX_OPENROUTER_STT_USAGE_FILE`, use that path instead.
6. **Restart the voice gateway** when the console offers it. Saved speech settings take effect
   then.
7. **Check it.** The **Overview** page's **Speech recognition** card shows which recognizer is
   in use, whether OpenRouter is ready and with which model, and what it has cost this month and
   today, as OpenRouter reported it. Months and days are counted in UTC.

### Which model

| Model | Cost per hour of audio | Notes |
|---|---|---|
| `nvidia/parakeet-tdt-0.6b-v3` (default) | about $0.06 | The same family as Phoenix's own Parakeet, and like it, not known for writing words when nobody spoke. Recommended. |
| `qwen/qwen3-asr-0.6b` | about $0.012 | **Not recommended:** in a live test it wrote `"The."` on every clip with no speech (silence and background noise alike). Phoenix treats a real empty answer as "listen again", so Jibo would act on "the" instead of listening again. The console warns when it is chosen. |
| `openai/gpt-4o-mini-transcribe` | priced per token, not per second | **Not currently working through OpenRouter:** every request was refused with "too many requests" from the provider in a live test on 2026-11-12 (none were billed). The console warns when it is chosen; re-test before relying on it. |
| Whisper models | from about $0.012 | Not recommended: they can write words when nobody spoke, and some of the companies behind them bill every recording as at least 10 seconds. The console warns when one is chosen. |

Prices are from OpenRouter's list on 2026-11-12 and change; the model list in the console shows
the current ones. Models that cost more than $1 per hour of audio can't be chosen: Phoenix sets
aside $1 per hour of audio before each recording and settles the real cost afterwards, so a
dearer model could spend past the budget before it is counted.

## Use your own speech server

These servers accept the upload format Phoenix sends:

- NVIDIA Speech NIM, including Parakeet TDT
- Speaches (faster-whisper)
- LiteLLM
- the open-source parakeet-asr-server
- whisper.cpp's server, when started with `--inference-path /v1/audio/transcriptions`
  (its default path is different)

Phoenix's own `services/parakeet-asr` does not use this format. Keep it under **Recognition
server**, which streams to it and is faster.

1. **Set the address.** Go to **Settings → Speech recognition → Your speech server** and enter
   its address, for example `http://localhost:8000`. An address ending in `/v1` or in
   `/v1/audio/transcriptions` works too. An openrouter.ai address is refused: choose OpenRouter
   instead.
2. **Add its key**, only if the server needs one, under **Your speech server's key**. It is sent
   only to that server. The OpenRouter key is never sent there.
3. **Pick the model**, if the server has more than one, under **Your speech server's model**.
   Once the address is saved, the list shows the models the server reports; you can also type
   a name.
4. **Choose when it is used.** Under **Speech recognizer**, choose **Your own speech server**,
   or choose **Parakeet with fallback** and a **Fallback order** that includes your server.
5. **Restart the voice gateway** when the console offers it.

A server you run yourself needs no budget. For a server that charges, set **Your speech
server's monthly limit** under **More settings**, in minutes of audio. A limit needs its own
usage file, created once the same way:
`node scripts/init-openai-stt-usage.mjs "$PHOENIX_DATA_DIR/asr/custom-stt-usage.json"`.

## When something goes wrong

The overview lists anything that keeps OpenRouter or your server from answering, in words.
The common cases:

| The overview says | What to do |
|---|---|
| There is no OpenRouter key | Add it under **Language models**. |
| Its usage file hasn't been created | Run the command in step 5 above, then restart the voice gateway. |
| Its monthly budget is zero | Raise **OpenRouter speech monthly budget**. |
| It has used this month's budget | It starts again next month (UTC), or raise the budget. |
| The key was refused | Check the key, then restart the voice gateway. |
| OpenRouter says the account needs credit | Add credit in your OpenRouter account. |
| The request was refused | Check the model name. |

After an error Phoenix pauses that recognizer instead of failing every question the same way:
five minutes for a key, credit or model problem, as long as the provider asks after "too many
requests", and thirty seconds otherwise. In **Parakeet with fallback**, the next one in the
fallback order answers meanwhile. An error is never treated as silence: only a real empty
answer makes Jibo listen again.

## Settings reference

The console writes these for you. A server set up without the console can put them in its
environment file instead.

| Setting | Console name | Default |
|---|---|---|
| `PHOENIX_ASR_PROVIDER` | Speech recognizer: `parakeet`, `auto`, `google`, `openrouter`, `custom` | `parakeet` |
| `PHOENIX_ASR_FALLBACK_ORDER` | Fallback order, for example `openrouter,google` | `openrouter,google` |
| `OPENROUTER_API_KEY` | OpenRouter key (under Language models) | none |
| `PHOENIX_OPENROUTER_STT_MODEL` | OpenRouter speech model | `nvidia/parakeet-tdt-0.6b-v3` |
| `PHOENIX_OPENROUTER_STT_MONTHLY_USD` | OpenRouter speech monthly budget | `2` |
| `PHOENIX_OPENROUTER_STT_DAILY_USD` | OpenRouter speech daily budget | a tenth of the month |
| `PHOENIX_OPENROUTER_STT_USAGE_FILE` | OpenRouter speech usage file (shown, set on the server) | `$PHOENIX_DATA_DIR/asr/openrouter-stt-usage.json` |
| `PHOENIX_CUSTOM_STT_URL` | Your speech server | none |
| `PHOENIX_CUSTOM_STT_API_KEY` | Your speech server's key | none |
| `PHOENIX_CUSTOM_STT_MODEL` | Your speech server's model | none |
| `PHOENIX_CUSTOM_STT_MONTHLY_MINUTES` | Your speech server's monthly limit | no limit |

The voice gateway also reads a few settings the console doesn't show:
`PHOENIX_OPENROUTER_STT_LANGUAGE` and `PHOENIX_CUSTOM_STT_LANGUAGE` (default `en`; `auto` lets
the model detect the language), `PHOENIX_OPENROUTER_STT_TIMEOUT_MS` and
`PHOENIX_CUSTOM_STT_TIMEOUT_MS`, `PHOENIX_OPENROUTER_STT_MONTHLY_MINUTES`,
`PHOENIX_CUSTOM_STT_MONTHLY_USD` with `PHOENIX_CUSTOM_STT_USD_PER_HOUR`, and
`PHOENIX_CUSTOM_STT_USAGE_FILE`.

Whatever recognizer answers, Phoenix rewrites its text the way Parakeet writes it (lower-case
words, numbers spelled out) before working out what was asked. See
[ASR-GOOGLE-FALLBACK.md](ASR-GOOGLE-FALLBACK.md) for Google, which is set up separately.
