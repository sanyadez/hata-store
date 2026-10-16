# Hata Store

The app store of [Hata](https://github.com/sanyadez/hata), a home server with a web dashboard.

Every app here is a plain Docker Compose file that runs as it is with `docker compose up`, with or
without Hata, and a `hata.yml` next to it that tells Hata what the compose file cannot: the app's name
and description in several languages, its icon, which page to open, and what to ask the person before
installing.

The files of this repository are under the MIT licence, except the apps that came from the
[CasaOS AppStore](https://github.com/IceWhaleTech/CasaOS-AppStore): those are under the Apache License 2.0
and changed for this store — see [NOTICE](NOTICE). The apps themselves belong to their authors and
come under their own licences; names and logos are their owners' trademarks. Most icons are taken from
[dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (Apache-2.0).

## Layout

```
store.yml                 the store's name, categories, apps the first run offers
apps/
  <app>/                  the folder's name is the app's id: a-z, 0-9 and dashes
    compose.yml           plain Docker Compose
    hata.yml              what Hata needs besides
    screenshots/          optional: PNG, JPEG or WebP, listed in hata.yml
    …                     optional: other files, see below
scripts/                  the checks (Bun, no packages)
```

### Other files

Anything else in the app's folder goes with it: Hata puts it next to the compose file, so a config is
mounted as `./nginx.conf:/etc/nginx/nginx.conf:ro`. Such files are text (UTF-8), plain files (no links),
256 KB together at most; `.env` and `compose.override.yml` are Hata's and cannot come from here. A
`.env.example` for those who run the app without Hata is welcome; the variables it sets must be the
compose file's.

## The compose file

It must start in an empty folder with `docker compose up` alone. So:

- **Every variable has a default**: `${WEB_PORT:-8096}`, or `${DB_PASSWORD:?why}` when there can be none
  (a password: compose then refuses to start and says why). A default never names another variable.
- **The app's data lives in `${APP_DATA:-.}/…`**: Hata points `APP_DATA` at the app's folder in the
  server's data folder; without Hata it is the folder of the compose file. A folder the person chooses
  (media, photos) is a setting of type `folder`. A relative path (`./data`) is refused unless it is one
  of the app's own files.
- **Images are published ones, pinned to a version**: `nginx:1.27.3`, or a digest. `latest`, `stable`,
  `release`, `nightly` and the like are refused: the store's update is the change of the tag.
- **`restart: unless-stopped`** (or `always`) on every service, or the app stays down after a reboot. A
  service that only prepares something and ends has `restart: "no"`, and another one waits for it with
  `condition: service_completed_successfully`.
- **No `container_name`** (an app could not be installed twice), **no `env_file`** (the `.env` is
  Hata's; name the variables in `environment`), **no `build`**, **no `x-…` keys** (they go into
  `hata.yml`), and no `name:` other than the folder's.
- Published ports are best made settings of type `port` — `${WEB_PORT:-8096}:8096` — so Hata can
  choose another number when this one is taken.

Variables Hata writes into the app's `.env`:

| Variable   | Value                                                   |
|------------|---------------------------------------------------------|
| `APP_DATA` | the app's own data folder, `<data folder>/AppData/<app>` |
| `APP_URL`  | the address the app is opened at, without a path: `https://<app>.<domain>` when Hata has a domain with HTTPS, else `http://<server>:<port>` |
| `APP_HOST` | the host name of that address                           |
| `PUID`     | the user apps run as (1000 by default)                  |
| `PGID`     | that user's group                                       |
| `TZ`       | the server's time zone                                  |

Hata makes the app's folders before the first start and gives them to `PUID:PGID`. When the app's
address changes (a domain is set up, the port is changed), Hata writes the new `APP_URL` and
`APP_HOST` and recreates the app.

## hata.yml

```yaml
title: Jellyfin                      # up to 40 characters
tagline:                             # one line, up to 120
  en: Your films, series and music, streamed to any screen
  uk: Ваші фільми, серіали й музика на будь-якому екрані
description: { en: …, uk: … }        # markdown
notes: { en: …, uk: … }              # optional, markdown: what to know before installing
category: media                      # one of store.yml
developer: Jellyfin
website: https://jellyfin.org
source: https://github.com/jellyfin/jellyfin   # optional
icon: data:image/svg+xml;base64,…    # see Icons
screenshots: [1.webp, 2.webp]        # optional, files in screenshots/
web:                                 # optional: an app without a web page has none
  service: jellyfin                  # the service that serves it
  port: 8096                         # the CONTAINER's port; Hata finds where it is published
  path: /                            # optional
  scheme: http                       # optional, http or https
settings: [ … ]                      # see Settings
permissions: { … }                   # see Permissions
```

Every text is either a plain string (English) or a map of languages, where `en` is required. Write a
long text as a folded block (`en: >`): its lines are joined, and the page lays it out itself; a blank line
starts a new paragraph.

### Settings

What Hata asks before installing. Each setting is a variable of the compose file, and the answers are
written into the app's `.env` — the compose file itself stays as the store has it.

```yaml
settings:
  - name: MEDIA                      # the variable, like WEB_PORT
    type: folder
    default: ${DATA_ROOT}/Media      # may name DATA_ROOT, APP_DATA, PUID, PGID, TZ
    label: { en: Media folder, uk: Тека з медіа }
    hint: { en: …, uk: … }           # optional
    required: true                   # optional: it cannot be left empty
    advanced: true                   # optional: shown under "More"
```

| Type       | What the person sees                                   | In `.env`                 |
|------------|--------------------------------------------------------|---------------------------|
| `text`     | a field                                                | as typed                  |
| `number`   | a number field                                         | as typed                  |
| `port`     | a port; Hata offers a free one when the default is taken | the number              |
| `folder`   | a folder of the server, with the folder picker         | the absolute path         |
| `url`      | an address                                             | as typed                  |
| `password` | a hidden field                                         | as typed                  |
| `secret`   | nothing: Hata makes it (`length`, 32 by default)       | letters and digits        |
| `switch`   | a switch                                               | `true` or `false`         |
| `choice`   | a list of `options: [{ value, label }]`                | the chosen value          |

`DATA_ROOT` (the server's data folder) can be used in defaults only, not in the compose file.

## Updates

Dependabot looks at the images of every app once a week and opens a pull request for a newer version;
the workflow checks it and starts the app with it, and a merge is the update Hata offers to everybody
who has the app.

### Permissions

Whatever the compose file asks of the host beyond its own folders and ports must be explained, and Hata
shows it before installing. The check reads the compose file and requires a line for each of:

| Permission     | When                                                      |
|----------------|-----------------------------------------------------------|
| `host-network` | `network_mode: host`                                      |
| `host-pid`     | `pid: host`                                               |
| `privileged`   | `privileged: true`                                        |
| `devices`      | `devices:`                                                |
| `capabilities` | `cap_add:`                                                |
| `docker`       | Docker's socket is mounted: the app can control the server |
| `host-files`   | any other folder or file of the host is mounted (`/etc/localtime` and `/etc/timezone` read-only are free) |

```yaml
permissions:
  host-network:
    en: To find devices on the home network by themselves
    uk: Щоб самому знаходити пристрої в домашній мережі
```

### Icons

The icon is the picture itself, as a `data:` URI: an SVG (best), or a PNG or WebP of 256×256, up to
32 KB written out. An SVG may hold no scripts, event handlers, `foreignObject` or links outside itself.

```sh
bun scripts/icon.ts logo.svg       # prints the URI, the SVG made smaller first
```

### Screenshots

Up to 8 files in `screenshots/`, PNG, JPEG or WebP, up to 600 KB each, about 1280 pixels wide, each one
listed in `screenshots` in the order they are shown.

## Checks

[Bun](https://bun.sh) is all they need.

```sh
bun test                            # the rules themselves
bun scripts/check.ts                # every app; the registries are asked which architectures exist
bun scripts/check.ts --offline      # without the network
sudo bun scripts/smoke.ts jellyfin  # on a machine with Docker: install as Hata does, wait for the page
```

`check.ts` also runs `docker compose config` when Docker is there. `smoke.ts` gives every setting a
value (a free port, a made-up secret), starts the app, waits up to six minutes for its web page to
answer, and takes it down again with its volumes.

On every push the workflow runs the checks, starts the apps that changed, and publishes `index.json` —
every app with its compose file and other files, the architectures its images exist for and the version — to the
`index` branch. Hata downloads that one file:

```
https://raw.githubusercontent.com/sanyadez/hata-store/index/index.json
```

## Adding an app

1. Make `apps/<app>/` with `compose.yml` and `hata.yml`; take the compose file the app's authors
   publish and bring it to the rules above.
2. `bun scripts/check.ts` until it says all is well.
3. `sudo bun scripts/smoke.ts <app>` on a machine with Docker.
4. Open a pull request.
