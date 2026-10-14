# Public search metadata and optional catalogs

The public origin is `PHOENIX_SITE_URL` (an HTTP(S) origin, not a page URL).
Unconfigured installations keep relative canonical/sitemap links and do not
claim a hosted Organization/WebSite identity. Configure an origin before
submitting a sitemap to a search engine.

`staticRoutes({ sitemapEntries: () => [{ path: '/catalog/item', lastmod: '2026-10-13' }] })`
is the optional catalog seam. The provider runs on every sitemap request so an
unpublished item disappears immediately. Pass only publicly listed pages; the
account layer validates local paths, rejects private routes and invalid dates,
and deduplicates locations. `lastmod` is optional: use a real content publication
or modification time, never startup time or the date of a sitemap fetch. With no
provider, the generic project sitemap and operator pages work as before.

Landing pages (`body[data-page="landing"]`, including operator index overrides)
receive JSON-LD derived from the same branding and origin as the served page.
`seo.sameAs` may override the default `links.github` identity list. Only HTTPS
URLs without credentials are accepted. Existing JSON-LD is left intact. There
is no FAQ schema injection: do not mark up answers that differ from visible
operator content, and do not promise FAQ rich results.

The SVG favicon is still the primary browser icon. The shipped ICO (16/32/48)
and Apple 180×180 PNG are rasterizations of that same asset, not new artwork.

## Security discovery

`/.well-known/security.txt` points to the existing instance `/security` page.
Without an HTTPS origin it uses the public repository's security page instead
of an invalid relative or plain-HTTP Contact URI. This is discovery, not a claim that an inbox or
private reporting channel has been provisioned. For an operated instance,
point `PHOENIX_SECURITY_FILE` at an owner-reviewed RFC 9116 text file outside the
checkout. Include an actual HTTPS reporting URL or mailto contact, an Expires
value no more than a year out, and the instance policy URL. Never publish an
example or placeholder address as if it were monitored. The shipped discovery
file expires on 2027-04-01; review it before then. Override content is cached,
like operator pages, until the account service restarts.

Robots directives are not access control and do not remove already indexed
pages. Console HTML retains its existing noindex metadata. The explicit /apps
allow precedes the compatibility /app prefix rule for prefix-only parsers;
Google/Bing also honor the exact /app$ rule and the most-specific allow rule.
Keep that precedence when editing robots.txt.

Serve portal routes through Account (or mirror the dynamic sitemap and
security.txt routes in the front proxy). A reverse proxy serving raw files from
disk cannot render the instance identity or a changing catalog sitemap.
