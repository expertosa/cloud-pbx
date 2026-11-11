# السنترال السحابي (Cloud PBX)

بدالة هاتف سحابية عربية للشركات الصغيرة والمتوسطة: رقم للشركة، رد آلي بالعربي، مجموعات رنين، بريد صوتي، تسجيل مكالمات، ورد واتصال من المتصفح أو الجوال. مبنية فوق **Asterisk 20** و **Node.js**، والاتصال بشبكة الهاتف عبر **Telnyx**.

## وش يسوي الـ MVP

| الميزة | التفاصيل |
| --- | --- |
| استقبال المكالمات | رقم Telnyx يوصل للرد الآلي أو مجموعة أو موظف مباشرة |
| الرد الآلي (IVR) | رسالة ترحيب مرفوعة من الشركة، أزرار 0–9 و *، وكتابة رقم التحويلة مباشرة |
| مجموعات الرنين | رنين جماعي أو بالترتيب، وتحويل لبريد صوتي أو وجهة ثانية إذا ما أحد رد |
| أوقات الدوام | مسار مختلف بعد الدوام حسب المنطقة الزمنية للشركة |
| البريد الصوتي | رسالة عربية ثم صافرة، والتسجيل يظهر في اللوحة |
| تسجيل المكالمات | اختياري لكل شركة، ويتشغّل من سجل المكالمات |
| هاتف المتصفح | WebRTC داخل اللوحة: رد واتصال وكتم ولوحة أرقام |
| الجوال والهاتف المكتبي | كل تحويلة لها حساب SIP لتطبيقات مثل Zoiper، ويرن مع المتصفح |
| الاتصال الصادر | 05xxxxxxxx يتحول تلقائياً إلى +9665xxxxxxxx ويظهر برقم الشركة |
| الحماية من الاحتيال | الدول المسموحة فقط، حجب الأرقام المميزة (700 و 9xx والفضائية)، وحد يومي للدقائق |
| تعدد الشركات | كل شركة معزولة ببياناتها وتحويلاتها وأرقامها |
| ربط الأنظمة | Webhooks موقعة بـ HMAC عند بداية المكالمة وردها ونهايتها وعند وصول بريد صوتي وعند تحويل الموظف الذكي |
| الموظف الذكي | اختياري ومطفي افتراضياً: صوت AudioSocket لخدمة خارجية ثم تحويل لموظف. التفاصيل في `docs/ai-receptionist.md` |
| إدارة المنصة | حساب مدير المنصة ينشئ الشركات ويوزع أرقام Telnyx عليها |

## البنية

```
المتصل ──► Telnyx ──SIP──► Asterisk (PJSIP) ──ARI──► API (Node.js) ──► PostgreSQL
                              ▲    ▲                       │
          هاتف المتصفح ──WSS──┘    └──SIP── Zoiper/هاتف    └──► لوحة التحكم (React، عربي RTL)
```

* **Asterisk** يمسك الصوت فقط. كل منطق المكالمة (IVR، الرنين، البريد الصوتي، التسجيل، الصادر) في `server/src/engine/calls.ts` عبر ARI.
* التحويلات تُنشأ في Asterisk ديناميكياً عبر ARI وتنحفظ في AstDB، وتنعاد مزامنتها كل ما اتصل الـ API بـ Asterisk.
* لكل تحويلة حسابين: `w<slug><رقم>` للمتصفح (WebRTC) و `<slug><رقم>` للجوال والأجهزة، ويرنون مع بعض.

```
asterisk/   إعدادات Asterisk (قوالب) + Dockerfile
server/     الـ API ومحرك المكالمات (Fastify + ARI)
web/        لوحة التحكم وهاتف المتصفح (React + JsSIP)
prompts/    رسائل النظام العربية (8kHz WAV)
deploy/     Caddyfile
```

## النشر على سيرفر (VPS)

**المتطلبات:** سيرفر Linux فيه Docker، IP عام ثابت، ودومين يشير له (مثل `pbx.example.com`). الأفضل يكون السيرفر في السعودية أو قريب منها عشان جودة الصوت.

```bash
git clone https://github.com/expertosa/cloud-pbx && cd cloud-pbx
cp .env.example .env      # عبّي القيم، وولّد الأسرار بـ: openssl rand -hex 24
docker compose up -d --build
```

افتح `https://<الدومين>` وادخل بحساب `SUPERADMIN_EMAIL`.

**المنافذ اللي لازم تنفتح في الجدار الناري:**

| المنفذ | لماذا |
| --- | --- |
| 80, 443 TCP | اللوحة وهاتف المتصفح (Caddy يطلع شهادة SSL تلقائياً) |
| 5060 UDP/TCP | SIP من Telnyx ومن تطبيقات الجوال |
| 10000–20000 UDP | الصوت (RTP) |

على سيرفر فيه Coolify وTraefik ماسك 80/443 (مثل hetzner-hel1) لا تشغّل هذا الملف: Caddy على شبكة الهوست يتعارض مع Traefik. استخدم القسم اللي بعده.

## النشر على Coolify

الملف `docker-compose.coolify.yml` يشغّل Asterisk والـ API على شبكة الهوست، وما يشغّل Caddy. Traefik يطلع شهادة `pbx.opps.dev`.

هاتف المتصفح ما يمرر SIP من نفس منفذ اللوحة. JsSIP يفتح `wsUrl` كما يرجع من `GET /api/phone`، والقيمة هي `SIP_WS_URL` بحذافيرها (`web/src/components/Phone.tsx`). الإنتاج: `wss://pbx.opps.dev/ws`. المسار `/ws` يخدمه Asterisk على `127.0.0.1:8088` (`asterisk/etc/http.conf` و `transport-ws` في `pjsip.conf`)، واللوحة والـ API على `127.0.0.1:3000`. `/ari` يبقى على Asterisk وما ينفتح للإنترنت.

Traefik حق Coolify داخل حاوية، فـ `127.0.0.1` عنده مو السيرفر. خدمة `edge` (nginx على شبكة الهوست، منفذ `9080` فقط) توصل الاثنين لعنوان يقدر الـ proxy يوصله. إعداد nginx يتبنى داخل الصورة من `deploy/Dockerfile.edge`، فـ Coolify ما يحتاج «Preserve repository during deployment» عشان ملف الإعداد. مسار واحد يكفي:

| الطلب | الوجهة |
| --- | --- |
| `https://pbx.opps.dev/ws` | nginx `:9080` ثم `127.0.0.1:8088` (SIP WebSocket) |
| أي مسار ثاني على نفس الدومين | nginx `:9080` ثم `127.0.0.1:3000` |

انسخ `deploy/coolify-traefik.yaml` من لوحة Coolify: Servers ← Proxy ← Dynamic Configurations، باسم `pbx-opps-dev.yaml`. لا تضف الدومين على مورد Coolify نفسه: حاوية `network_mode: host` ما لها عنوان على شبكة `coolify`، وملصق Traefik يطلع 503.

**إنشاء المورد**

1. GitHub App على `expertosa/cloud-pbx`، Build Pack: Docker Compose.
2. Docker Compose Location: `/docker-compose.coolify.yml`.
3. عطّل `Connect To Predefined Network`. تفعيلها يدمج شبكة مع `network_mode: host` والنشر يفشل.
4. متغيرات البيئة من `.env.example` في واجهة Coolify (تصير ملف `.env` وقت النشر). لا تحط أسرار Telnyx في git.
5. تأكد أن قالب الـ proxy فيه `extra_hosts: host.docker.internal:host-gateway` (الافتراضي فيه). اسم `certResolver` الافتراضي `letsencrypt`.

**المتغيرات اللي تهم pbx.opps.dev**

| المتغير | القيمة |
| --- | --- |
| `PUBLIC_URL` | `https://pbx.opps.dev` |
| `SIP_WS_URL` | `wss://pbx.opps.dev/ws` |
| `SIP_DOMAIN` | `pbx.opps.dev` |
| `EXTERNAL_IP` | `2.29.52.193` |
| `DOMAIN` | غير مستخدم في ملف Coolify (Caddy فقط) |
| `POSTGRES_PASSWORD` `JWT_SECRET` `ARI_PASSWORD` | `openssl rand -hex 24` |
| `SUPERADMIN_EMAIL` `SUPERADMIN_PASSWORD` | حساب مدير المنصة |
| `TRUNK_MODE` `TELNYX_SIP_USER` `TELNYX_SIP_PASSWORD` `TELNYX_SIP_HOST` | من لوحة Telnyx. مع `registration` الـ Asterisk ما يشتغل إذا اسم المستخدم أو كلمة المرور فاضيين؛ خلّ `TRUNK_MODE=none` لين ما تتوفر |
| `TELNYX_API_KEY` `TELNYX_BALANCE_LOW_THRESHOLD` | مفتاح API v2 لقراءة الرصيد في لوحة مدير المنصة (اختياري). حد التنبيه الافتراضي 10 دولار |
| `RTP_START` `RTP_END` | `10000` و `20000` |

إذا كلمة السر فيها `$` اكتبها `$$` في Coolify، لأن Compose يفسّر `$`.

**الجدار الناري على 2.29.52.193**

| المنفذ | لماذا |
| --- | --- |
| 22 TCP | SSH |
| 80 و 443 TCP | Traefik (اللوحة و `wss://…/ws`) |
| 5060 UDP و TCP | SIP من Telnyx وتطبيقات الجوال |
| 10000–20000 UDP | RTP |

لا تفتح `3000` ولا `5432` ولا `8088` ولا `9080`. `8088` فيه ARI، و`9080` هو مدخل nginx الداخلي. جدار Hetzner السحابي ما يمس حركة جسر Docker، فـ Traefik يوصل `host.docker.internal:9080` بدون ما تنفتح هالمنافذ للإنترنت. إذا `ufw` شغّال على السيرفر، اسمح لبوابة شبكة `coolify` إلى TCP `9080` وإلا النتيجة 502.

اتصال WebSocket الساكت قد يقطعه Traefik بعد مهلة الخمول الافتراضية (180 ثانية) ويرجع JsSIP يتسجل. إذا انقطع هاتف المتصفح وهو خامل، زِد `entrypoints.https.transport.respondingTimeouts.idleTimeout` في إعداد الـ proxy.

## ربط Telnyx

1. **SIP Connection:** من لوحة Telnyx ← Voice ← SIP Connections ← Add. اختر **Credentials** وحط اسم مستخدم وكلمة مرور قوية. انسخهم في `.env` تحت `TELNYX_SIP_USER` و `TELNYX_SIP_PASSWORD`، وخلّ `TRUNK_MODE=registration`.
2. **الأكواد:** فعّل G.711U و G.711A في الاتصال.
3. **Outbound Voice Profile:** أنشئ واحد واربطه بالـ SIP Connection، وفي قائمة الدول المسموحة فعّل السعودية (وأي دولة تحتاجها).
4. **الرقم:** اشترِ رقم (للتجربة يكفي رقم أمريكي) واربطه بنفس الـ SIP Connection.
5. أعد تشغيل Asterisk: `docker compose restart asterisk`. من صفحة إدارة المنصة لازم يطلع «خط الاتصال: جاهز».
6. أضف الرقم من صفحة إدارة المنصة بصيغة دولية (مثل `+15551234567`) واختر الشركة.
7. **رصيد الحساب:** لوحة مدير المنصة تعرض الرصيد المتاح من Telnyx (`GET /v2/balance`) إذا وُضع `TELNYX_API_KEY`، مع زر «إضافة رصيد» يفتح [صفحة الدفع في Mission Control](https://portal.telnyx.com/#/billing/payment). الشحن يتم من بوابة Telnyx فقط (ما فيه شحن من اللوحة). التنبيه يظهر إذا نزل `available_credit` تحت `TELNYX_BALANCE_LOW_THRESHOLD` (الافتراضي 10 دولار). مدراء الشركات ما يشوفون رصيد المنصة.

إذا اخترت اتصال Telnyx بنوع **IP Address** بدل Credentials: خلّ `TRUNK_MODE=ip`، حط IP السيرفر في Telnyx، وعبّي `TELNYX_SIGNALING_IPS` بعناوين Telnyx المذكورة في توثيقهم.

## تجهيز أول عميل (10 دقائق)

1. **إدارة المنصة ← شركة جديدة:** اسم الشركة وبريد المسؤول وكلمة مرور مؤقتة. تنشأ تحويلة 101 للمسؤول تلقائياً.
2. **إدارة المنصة ← أرقام Telnyx:** أضف رقم الشركة واختر الشركة.
3. ادخل بحساب الشركة (أو خلّ العميل يدخل) وسوّ التالي:
   * **الموظفون والتحويلات:** أضف الموظفين، وكل واحد تنشأ له تحويلة.
   * **مجموعات الرنين:** مثلاً «الاستقبال» فيها الموظفين، وإذا ما أحد رد ← بريد صوتي.
   * **الرد الآلي:** ارفع تسجيل الترحيب، واربط الأزرار (1 ← الاستقبال، 2 ← المحاسبة...).
   * **الأرقام ومسار المكالمة:** الرقم ← الرد الآلي، ومع أوقات الدوام إذا تبي.
   * **الإعدادات:** اختر الرقم اللي يظهر في المكالمات الصادرة، وفعّل التسجيل إذا تبي.
4. كل موظف يدخل اللوحة، يسمح للمتصفح بالمايك، ويصير هاتف المتصفح «متصل وجاهز». ولو يبي يرد من الجوال: زر «ربط جوال» يعطيه بيانات Zoiper.

## التطوير محلياً

```bash
# Postgres + Asterisk محلي (Ubuntu): apt install asterisk asterisk-modules sox postgresql gettext-base
cd server && npm i
export DATABASE_URL=postgres://... JWT_SECRET=... ARI_PASSWORD=...   # نفس أسماء .env.example
npm run dev          # API على :3000
cd ../web && npm i && npm run dev   # اللوحة على :5173
cd ../server && npm test            # اختبارات الأرقام وأوقات الدوام
```

للاختبار بدون Telnyx: `TRUNK_MODE=none TEST_TRUNK=1` يضيف `testtrunk` (باسم مستخدم وكلمة مرور) لإدخال مكالمات، و `TRUNK_ENDPOINT=sim-carrier` يرسل الصادرة إلى `sip:carrier@127.0.0.1:5090`. `sim-carrier` لا يُعرف بالاسم: الوارد عليه فقط من `127.0.0.1:5090` (أو `TEST_TRUNK_MATCH`)، لأن مسار `/ws` العام يصل لأستريسك من `127.0.0.1` ولو طابقنا كل الحلقة المحلية لصارت مكالمات المتصفح واردة على الخط.

لتجربة صوت الموظف الذكي على نفس الجهاز (بدون ناقل): `AI_RECEPTIONIST_ENABLED=true` ثم `cd server && npm run audiosocket-echo`. العقد كامل في `docs/ai-receptionist.md`.

## رسائل النظام الصوتية

الرسائل في `prompts/` مولّدة آلياً (espeak-ng) كبداية فقط وصوتها آلي. قبل أول عميل، سجّلها بصوت بشري أو بخدمة TTS عربية، بنفس الأسماء، ونصوصها في `prompts/prompts.tsv`. أي صيغة تشتغل، بس الأفضل WAV أحادي 8kHz.

## الأمان

* ARI والـ WebSocket مربوطين على `127.0.0.1` فقط، والوصول من الخارج يمر عبر Caddy بـ HTTPS.
* كلمات مرور SIP عشوائية (20+ حرف) ويقدر المدير يغيرها من اللوحة.
* الاتصال الدولي مقفل افتراضياً، والأرقام المميزة محجوبة دائماً، وفيه حد يومي للدقائق.
* ننصح بـ fail2ban على `/var/log/asterisk/security.log`، وتقييد منفذ 5060 على عناوين Telnyx إذا ما تستخدمون تطبيقات الجوال.

## قبل الإطلاق التجاري

* trunk سعودي مرخّص (موبايلي/STC) أو تصريح VVSP. Telnyx للتجربة فقط.
* تسجيل رسائل النظام بصوت بشري.
* نسخ احتياطي لقاعدة البيانات وللتسجيلات.
