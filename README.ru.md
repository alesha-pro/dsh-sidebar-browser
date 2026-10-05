# dsh-sidebar-browser

Управление **встроенным браузером DSH Desktop** (вкладка Browser в правой панели)
из агента: плагин с инструментами `browser_*` плюс автономный CLI без зависимостей.

Встроенный браузер — это Electron `<webview>` в правом сайдбаре. Из коробки он
только для человека: поставляемый пакет
`@deepseek-ai/dsh-client-ui-sidebar-browser` регистрирует UI-вкладку и **ни одного
инструмента для модели** (его хостовая половина — буквально `function apply() {}`).
Этот проект закрывает зазор, не трогая бандл приложения.

```
агент ──инструменты browser_*──▶ сырой CDP ──▶ guest <webview>  ◀── ты, смотришь ту же страницу
```

## Почему сырой CDP, а не Playwright/Puppeteer

Electron отдаёт сайдбарный guest как CDP-таргет типа **`webview`**. Playwright и
Puppeteer перечисляют только таргеты типа `page`, поэтому оба его не видят — и
хуже: если попросить их подключиться к отладочному порту приложения, они с
удовольствием возьмут оболочку харнесса:

```console
$ node probes/probe.mjs          # playwright-core, connectOverCDP
contexts: 1
  ctx0 app-shell :: dsh-app://app/
RESULT: no webview page found

$ node probes/pp-test.mjs        # puppeteer-core, connect()
puppeteer pages(): 1
  - dsh-app://app/ | <интерфейс харнесса>
!! puppeteer cannot see the webview as a page
```

Именно поэтому любой браузерный плагин на этих библиотеках начинает щёлкать по
интерфейсу харнесса вместо страницы, которую ты видишь. Этот плагин говорит с
guest'ом напрямую по его `webSocketDebuggerUrl` и фильтрует строго по
`type === 'webview'`, так что оболочку взять случайно невозможно.

## Требования

```sh
open -a "DeepSeek Harness" --args --remote-debugging-port=9222
```

* DSH Desktop **0.2.0-rc.2** или новее (замерено на Electron 44 / Chrome 152, macOS).
* Приложение **запущено с отладочным портом** — иначе инструменты есть, но каждый
  вызов вернёт внятную ошибку.
* **Открыта вкладка Browser** в правой панели: guest создаётся лениво, одного
  порта недостаточно.
* Node.js ≥ 20 для CLI (плагин работает внутри приложения).

## Установка плагина

Плагин ставится в *профиль* DSH (для DSH Desktop это профиль `desktop`), а не в
проект — поэтому инструменты потом доступны в любом workspace.

```sh
git clone https://github.com/alesha-pro/dsh-sidebar-browser.git
cd dsh-sidebar-browser/plugin
npm install                      # обязательно, см. примечание

dsh plugin --profile desktop add "$PWD"
# затем перезапустить DSH Desktop с отладочным портом
```

> **Зачем `npm install` внутри `plugin/`?** `dsh plugin add <путь>` подключает
> папку как `link:`, а не копирует её, поэтому импорты плагина
> (`@deepseek-ai/dsh-tools`, `schemastery`) резолвятся от его собственного
> каталога. Без `node_modules` там бандл не загрузится.

Проверка без перезапуска приложения — селфтест гоняет настоящий код плагина против
живого порта с подставным контекстом:

```sh
node plugin/selftest.mjs
```

## Инструменты

| Инструмент | Что делает |
|---|---|
| `browser_tabs` | список сайдбарных вкладок и какая из них управляется |
| `browser_snapshot` | заголовок, URL и пронумерованный инвентарь интерактивных элементов |
| `browser_navigate` | перейти по URL в текущей вкладке |
| `browser_click` | клик по номеру из snapshot (одинарный или двойной) |
| `browser_type` | ввод текста в элемент (React/Vue-совместимо, `replace` очищает поле) |
| `browser_press` | одна клавиша: Enter, Tab, Escape, стрелки, символ |
| `browser_scroll` | up / down / top / bottom — скроллит тот элемент, который реально скроллится |
| `browser_text` | видимый текст страницы |
| `browser_html` | outerHTML элемента по номеру |
| `browser_eval` | выполнить JS в контексте страницы |
| `browser_screenshot` | PNG вьюпорта; длинная страница — нарезкой по экранам |
| `browser_history` | back / forward / reload |
| `browser_cookies_export` | сохранить куки сайта в локальный vault |
| `browser_cookies_import` | вернуть vault после перезапуска |
| `browser_cookies_vaults` | список сохранённых vault'ов |

Номера элементов берутся из последнего `browser_snapshot` и живут на странице
атрибутом `data-dsh-idx`.

## CLI

Тот же движок без зависимостей и без установки в DSH — удобно для скриптов и
ручной проверки механизма:

```sh
node cli/browser.mjs tabs
node cli/browser.mjs snapshot
node cli/browser.mjs click 12
node cli/browser.mjs type 3 "привет" --replace
node cli/browser.mjs press Enter
node cli/browser.mjs scroll down 800
node cli/browser.mjs text --max 4000
node cli/browser.mjs eval "document.title"
node cli/browser.mjs screenshot out.png --full
node cli/browser.mjs navigate example.com
node cli/browser.mjs back | forward | reload
node cli/browser.mjs html 12
```

## Сессии и куки

Встроенный браузер **не хранит ничего между запусками приложения — так задумано**.
Оболочка выдаёт guest'ам партицию на время жизни процесса:

```js
// DesktopBrowserGuests.acquire(owner, workspace)
partition = `dsh-sidebar-browser-${randomUUID()}`
this.configureSession(session.fromPartition(partition))
```

Без префикса `persist:` это in-memory сессия, а случайный UUID всё равно означал бы
пустой профиль при следующем запуске. Та же сессия запрещает все разрешения,
блокирует загрузки файлов и пропускает только запросы `http(s)`, `data` и `blob`,
не адресованные самому харнессу.

Поэтому логины исчезают при выходе — это ожидаемое поведение, а не сбой. Обход —
cookie vault:

```sh
# пока залогинен, до выхода
#   browser_cookies_export {}                     -> ~/.dsh/cookie-vault/<хост>.json
# после перезапуска, с открытой вкладкой
#   browser_cookies_import { domain: "example.com" }
```

Файлы vault пишутся с правами `600` в каталог `700` и содержат **живые сессионные
токены в открытом виде** — обращайся с ними как с паролем и не коммить
(`.gitignore` их уже исключает).

## Замеренные особенности Electron-webview

| Поведение | Что происходит на самом деле |
|---|---|
| `Page.captureScreenshot` с `captureBeyondViewport` | размножает вьюпорт вместо страницы. Подтверждено сверкой с DOM: один `<h1>` и один инфобокс, а на картинке три копии. Поэтому `full: true` прокручивает и снимает нарезкой |
| `Page.reload` на guest | может унести CDP-таргет с собой; reload реализован навигацией на текущий URL |
| Таргет исчезает посреди вызова | теперь все ожидающие команды падают с подсказкой, а не висят вечно |
| Скролл SPA | `window.scrollY` остаётся нулём, пока скроллится внутренний контейнер — инструменты определяют цель сами |
| Чтение высоких картинок | лимит просмотрщика 8192 px по стороне — длинные страницы читаются нарезкой или кропом |

## Безопасность

* Отладочный порт слушает только loopback, но пока он открыт, к оболочке
  приложения может подключиться любой локальный процесс — не только к вкладке.
  Запускай приложение с флагом, когда инструменты нужны, а не постоянно.
* Код плагина исполняется в процессе приложения, вне песочницы workspace. Читай
  исходники, прежде чем ставить что-либо в профиль.
* Здесь ничего не меняет `DeepSeek Harness.app`: без распаковки `app.asar` и без
  повреждения подписи. Единственное изменение в системе — запись bundle в профиле
  и, если пользуешься, cookie vault.

## Структура

| Путь | Что это |
|---|---|
| `plugin/` | бандл DSH: `lib/index.js`, `cordis.patch.yml`, селфтест |
| `cli/browser.mjs` | автономный CLI на сыром CDP, без зависимостей |
| `probes/` | воспроизводимые негативные результаты: и Playwright, и Puppeteer не видят guest |

## Лицензия

MIT. Проект не связан с DeepSeek; внутренности DSH изучались только на чтение по
установленной копии.
