# الموظف الذكي (AI receptionist)

مسار صوتي اختياري: المكالمة الواردة توصل لخدمة استقبال خارجية (مشروع Receptionist)، وبعدها الخدمة تحوّل المتصل لموظف بشري يرد من Callolo أو هاتف المتصفح أو أي عميل SIP. منطق الذكاء نفسه مو هنا. هذا العقد يثبت مسار الصوت والتحويل.

الميزة **مطفية** إلا إذا `AI_RECEPTIONIST_ENABLED=true`. بدون هذا المتغير ما يتغير توجيه المكالمات الحالي، وواجهة الربط ترجع 404.

## الوجهة

في أي مكان تُختار فيه وجهة مكالمة (رقم، زر رد آلي، احتياط مجموعة رنين):

```json
{ "type": "ai_receptionist", "fallback": { "type": "ring_group", "id": "<uuid>" } }
```

`fallback` وجهة عادية (`extension` أو `ring_group` أو `ivr` أو `voicemail` أو `hangup`) وما تصير `ai_receptionist` مرة ثانية. تُستخدم إذا:

- العلم مطفي،
- عنوان الصوت مو على شبكة خاصة،
- Asterisk ما قدر يتصل بخدمة الصوت،
- اتصال الصوت انقطع قبل التحويل.

في اللوحة الاسم **الموظف الذكي**.

## الصوت

Asterisk في صورة `asterisk/Dockerfile` هو حزمة Ubuntu 24.04: **Asterisk 20.6.0** مع `asterisk-modules`. الحزمة فيها `chan_audiosocket.so` و `res_audiosocket.so` و `res_ari_channels.so`، و `autoload=yes` يحمّلها (مو في قائمة `noload`).

ARI:

```
POST /channels/externalMedia
  app=cloudpbx
  external_host=<host>:<port>
  encapsulation=audiosocket
  transport=tcp
  connection_type=client
  format=slin
  direction=both
  data=<call-session-uuid>
  channelId=ai-<call-session-uuid>
```

**لماذا `slin` وليس `slin16`:** في 20.6.0 الدالة `ast_audiosocket_send_frame` / `ast_audiosocket_receive_frame` تثبّت الإطار على «16-bit, 8 kHz signed linear mono» (`res/res_audiosocket.c`). إطار `slin16` ينوصل بسرعة غلط. `connection_type=server` غير منفّذ لهذا التغليف في هذا الإصدار: Asterisk يتصل هو بالعنوان (عميل TCP).

المتغيرات:

| المتغير | الافتراضي | المعنى |
| --- | --- | --- |
| `AI_RECEPTIONIST_ENABLED` | `false` | يفتح الوجهة وواجهة الربط |
| `AI_RECEPTIONIST_MEDIA_HOST` | `127.0.0.1` | عنوان خدمة الصوت |
| `AI_RECEPTIONIST_MEDIA_PORT` | `9092` | منفذ TCP |

العنوان لازم يكون loopback أو خاص (`127.0.0.0/8`، `10/8`، `172.16/12`، `192.168/16`، `localhost`، `::1`). عنوان عام يُرفض والمكالمة تروح للاحتياط. المهلة على طلب ARI أربع ثوانٍ، وبعدها نفس الاحتياط بدل ما نعلّق المتصل.

### إطار AudioSocket

كل رسالة: بايت النوع، ثم طول الحمولة big-endian على بايتين، ثم الحمولة.

| النوع | المعنى |
| --- | --- |
| `0x00` | إنهاء |
| `0x01` | معرّف المكالمة، 16 بايت خام (UUID بدون شرطات). Asterisk يرسله أول شيء بعد الاتصال. هذا هو `data`، ويساوي معرّف جلسة المكالمة |
| `0x10` | صوت slin: 16-bit little-endian، 8 kHz، قناة واحدة. 20ms = 320 بايت |
| `0xff` | خطأ |

القناة تدخل جسر mixing مع المتصل. الصوت في الاتجاهين.

تجربة محلية بدون ناقل مدفوع (ومع `TEST_TRUNK=1` في `render-config.sh` لإدخال مكالمة على trunk الاختبار):

```bash
cd server && npm run audiosocket-echo
# AI_RECEPTIONIST_ENABLED=true
# AI_RECEPTIONIST_MEDIA_HOST=127.0.0.1
# AI_RECEPTIONIST_MEDIA_PORT=9092
```

الخادم يرد الصوت كما وصل (صدى) ويطبع معرّف المكالمة.

## واجهة الربط

رمز خدمة لكل شركة. يُنشأ من **الإعدادات ← الموظف الذكي** ويظهر **مرة واحدة**. في القاعدة يُحفظ SHA-256 فقط (`tenant_integrations.token_hash`)، والرمز مربوط بشركة واحدة. إيقاف الرمز يملأ `revoked_at`.

```
Authorization: Bearer pbx_…
```

```
POST /api/integrations/calls/:id/transfer
{
  "destination": { "type": "ring_group", "id": "<uuid>" },
  "summary": "العميل يسأل عن الفاتورة",
  "external_ref": "recv-123"
}

POST /api/integrations/calls/:id/hangup
```

`:id` هو نفس UUID إطار `0x01`. `destination` ما تكون `ai_receptionist`.

التحويل:

1. يفصل قناة الصوت عن الجسر وينهيها.
2. يشغّل نفس منطق الوجهات الحالي (تحويلة، مجموعة، رد آلي، بريد صوتي). التحويلة ترن على حساب المتصفح وحساب SIP مع بعض، فيرد Callolo أو هاتف المتصفح أو Zoiper.
3. إذا ما أحد رد، يمشي احتياط المجموعة أو البريد الصوتي كما هو.

رمز شركة ثانية، أو مكالمة خلصت، يرجع **404** (ما نكشف وجود مكالمة لشركة غيرها). مكالمة مو عند الموظف الذكي ترجع **409**. علم مطفي: **404**.

### سياق المتصل على الرجل التي ترن

المكالمات العادية ما تتغير: ما زالت `PJSIP/<endpoint>` مباشرة.

بعد التحويل فقط، الرجل تصير `Local/<endpoint>@receptionist-handoff/n` عشان نقدر نكتب ترويسات SIP **قبل** الـ INVITE. Asterisk 20.6 يضع متغيرات ARI على قناة Local `;1` وما يستدعي دوال خطة الاتصال من واجهة المتغيرات، فالخطة تستوردها بـ `IMPORT()` ثم `Dial(...,b(receptionist-predial^s^1))` يكتب الترويسات على قناة PJSIP:

| الترويسة | القيمة |
| --- | --- |
| اسم المتصل ورقمه | `CALLERID` الأصلي (يظهر في Callolo وهاتف المتصفح) |
| `X-Receptionist-Call` | معرّف المكالمة |
| `X-Receptionist-Summary` | الملخص بعد حذف أسطر التحكم، حتى 160 حرفًا |

هاتف المتصفح يعرض الملخص تحت اسم المتصل إذا وصلت الترويسة.

## Webhook

نفس التوقيع الحالي: جسم JSON، والترويسة `X-CloudPBX-Signature: sha256=<hmac>` بمفتاح `webhook_secret` للشركة.

الحدث الجديد `call.transferred`:

```json
{
  "event": "call.transferred",
  "created_at": "2026-11-10T17:40:00.000Z",
  "data": {
    "call_id": "<uuid>",
    "from": "+9665…",
    "from_name": "Sara",
    "destination": { "type": "extension", "id": "<uuid>" },
    "external_ref": "recv-123",
    "summary": "العميل يسأل عن الفاتورة"
  }
}
```

أحداث `call.started` و `call.answered` و `call.ended` و `voicemail.created` كما هي. أعمدة جديدة على `calls`: `handled_by_ai`، `external_ref`، `transferred_at`. حالة `ai` تعني أن المتصل ما زال مع الموظف الذكي.

## أمان الصوت

AudioSocket على هذا الإصدار **بدون مصادقة**. أي طرف يقدر يستمع أو يحقن صوتًا إذا وصل للمنفذ. خدمة الصوت لازم تكون على `localhost` أو شبكة خاصة، والمنفذ ما ينفتح على الإنترنت. رمز الخدمة لواجهة HTTP فقط، مو للصوت. لا تحط الرمز في git؛ أنشئه من اللوحة.
