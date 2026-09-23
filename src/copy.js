import { cfg } from "./config.js";

const NAME = cfg.owner.name;

/**
 * The poster QR prefills a message in the language of the poster they scanned,
 * so the first inbound message tells us which language to speak.
 */
export function detectLang(text = "") {
  if (/[一-鿿]/.test(text)) return "zh";
  if (/\b(saya|nampak|nak tahu|kedai|pembekal|lanjut|boleh)\b/i.test(text))
    return "ms";
  return "en";
}

const S = {
  en: {
    listBody:
      `Hi! I’m Ledger’s booking assistant, helping ${NAME} arrange shop visits.\n\n` +
      `I come by once for about 20 minutes, write down the suppliers you already use ` +
      `and the things you usually order. After that you just send one voice note when you need stock.\n\n` +
      `We store your contact and booking details to arrange the visit. Reply STOP to stop automated replies. Pick a quiet time:`,
    listHeader: "Book your 20 minutes",
    listButton: "Pick a time",
    listSection: "This week",
    slotDesc: (n) => `${n} min at your shop`,
    otherTime: "Another time",
    otherTimeDesc: "Tell me what suits and I'll work around it",
    booked: (iso) =>
      `Booked: ${iso}. I'll come to you.\n\n` +
      `What's your shop name and unit number? (e.g. "Ah Seng Provisions, Blk 824 #01-24")`,
    saved:
      `Got it, thanks. See you then.\n\n` +
      `Nothing to prepare. If your supplier numbers are saved in your phone, that's all we need.\n\n` +
      `Any questions before that, just message here.`,
    handover: `I’ve passed this to ${NAME}. A person will follow up here.`,
    slotGone: `Sorry, someone just took that one. Here are the next times:`,
    noSlots:
      `I'd like to come by this week but my slots are full. ` +
      `Tell me which afternoon suits you and I'll make it work.`,
    notInterested: `No problem at all, thanks for letting me know. If you change your mind the number stays the same.`,
  },

  zh: {
    listBody:
      `你好！我是 Ledger 的预约助手，帮 ${NAME} 安排上门时间。\n\n` +
      `我上门一次,大概二十分钟,把你现在用的供应商和常订的货记下来。之后你要补货,` +
      `只要发一段语音给我们就可以。\n\n` +
      `选一个你比较空的时间:`,
    listHeader: "预约二十分钟",
    listButton: "选时间",
    listSection: "这个星期",
    slotDesc: (n) => `上门 ${n} 分钟`,
    otherTime: "其他时间",
    otherTimeDesc: "告诉我你方便的时间,我配合你",
    booked: (iso) =>
      `已经约好:${iso}。我到时候过去。\n\n` +
      `请问你的店名和单位号是?(例如:发记杂货,824座 #01-24)`,
    saved:
      `收到,谢谢。到时候见。\n\n` +
      `不用准备什么。供应商的号码存在手机里就够了。\n\n` +
      `之前有什么问题,直接在这里问我。`,
    handover: `我已把消息转交给 ${NAME}，稍后由真人回复你。`,
    slotGone: `不好意思,那个时段刚被约走了。这几个时间还可以:`,
    noSlots: `这个星期的时段满了。你讲一个方便的下午,我尽量配合。`,
    notInterested: `没问题,谢谢你告诉我。以后改变主意的话,号码还是这个。`,
  },

  ms: {
    listBody:
      `Hai! Saya pembantu tempahan Ledger untuk ${NAME}.\n\n` +
      `Saya datang sekali, lebih kurang 20 minit, untuk catat pembekal yang anda guna sekarang ` +
      `dan barang yang anda selalu pesan. Selepas itu anda hantar satu nota suara sahaja bila perlu stok.\n\n` +
      `Pilih masa yang lapang untuk anda:`,
    listHeader: "Tempah 20 minit",
    listButton: "Pilih masa",
    listSection: "Minggu ini",
    slotDesc: (n) => `${n} minit di kedai anda`,
    otherTime: "Masa lain",
    otherTimeDesc: "Beritahu masa yang sesuai, saya ikut anda",
    booked: (iso) =>
      `Sudah ditempah: ${iso}. Saya datang ke kedai anda.\n\n` +
      `Apa nama kedai dan nombor unit anda? (cth. "Kedai Pak Samad, Blok 824 #01-24")`,
    saved:
      `Baik, terima kasih. Jumpa nanti.\n\n` +
      `Tiada apa nak sediakan. Kalau nombor pembekal ada dalam telefon anda, itu sudah cukup.\n\n` +
      `Ada soalan sebelum itu, terus mesej di sini.`,
    handover: `Saya telah serahkan kepada ${NAME}. Beliau akan membalas anda di sini.`,
    slotGone: `Maaf, slot itu baru diambil orang. Ini masa yang masih ada:`,
    noSlots: `Slot minggu ini penuh. Beritahu petang mana yang sesuai, saya cuba sesuaikan.`,
    notInterested: `Tidak mengapa, terima kasih kerana beritahu. Kalau berubah fikiran, nombor ini sama.`,
  },
};

export const t = (lang, key) => (S[lang] ?? S.en)[key] ?? S.en[key];

const extras = {
  en: {
    processing:
      "I’m checking that time with the calendar. I’ll confirm here once it is reserved.",
    stale:
      "That selection has expired or is no longer available. Please choose from these fresh times.",
    unavailable:
      "I can’t verify the calendar right now. I’ve asked a person to help arrange your visit.",
    detailsInvalid:
      "Please send both your shop name and address, separated by a comma. For example: Ah Seng Provisions, Blk 824 #01-24. You can also say cancel or human.",
    cancelPrompt:
      "Cancel this appointment? Your current time stays reserved until cancellation is confirmed.",
    cancelYes: "Cancel visit",
    keep: "Keep booking",
    kept: "Your appointment is unchanged.",
    cancelPending:
      "I’m cancelling the calendar event. I’ll confirm when it is done.",
    cancelled:
      "Your appointment has been cancelled. Reply BOOK whenever you want to arrange a new visit.",
    noBooking:
      "You don’t have an active appointment. Reply BOOK to choose a time.",
    alreadyBooked:
      "You already have an appointment. Reply RESCHEDULE to change it, CANCEL to cancel, or HUMAN for help.",
    pending:
      "Your appointment request is still being processed. A person can help if you reply HUMAN.",
    media:
      "I can’t read voice notes or images yet. Please type your request, or reply HUMAN for help.",
    faq: "Ledger helps shops arrange restocking by voice note. This assistant arranges the 20-minute onboarding visit; a person can explain pricing, suppliers, and service details.",
    languageChanged:
      "I’ll use English. Reply BOOK for an appointment or HUMAN for help.",
    chooseBook: "Book a visit",
    chooseHuman: "Talk to a person",
  },
  zh: {
    processing: "我正在核对日历，预留成功后会在这里确认。",
    stale: "这个选项已过期或不可用，请从新的时间中选择。",
    unavailable: "暂时无法核对日历。我已请真人帮你安排上门时间。",
    detailsInvalid:
      "请用逗号分隔店名和地址，例如：发记杂货，824座 #01-24。也可以回复“取消”或“人工”。",
    cancelPrompt: "确定取消预约吗？取消确认前，原来的时间仍然保留。",
    cancelYes: "取消预约",
    keep: "保留预约",
    kept: "你的预约保持不变。",
    cancelPending: "正在取消日历预约，完成后会通知你。",
    cancelled: "预约已取消。需要重新预约时，请回复“预约”。",
    noBooking: "你目前没有预约，回复“预约”即可选择时间。",
    alreadyBooked: "你已有预约。回复“改期”、“取消”或“人工”。",
    pending: "正在处理你的预约，请稍候。需要帮助请回复“人工”。",
    media: "暂时无法读取语音或图片，请输入文字，或回复“人工”。",
    faq: "Ledger 帮助商家用语音安排补货。这个助手用于预约二十分钟的上门介绍，价格和服务详情请向真人咨询。",
    languageChanged: "接下来我会使用中文。回复“预约”或“人工”。",
    chooseBook: "预约上门",
    chooseHuman: "联系真人",
  },
  ms: {
    processing:
      "Saya sedang semak kalendar. Saya akan sahkan selepas masa itu ditempah.",
    stale:
      "Pilihan itu telah tamat atau tidak tersedia. Sila pilih masa baharu.",
    unavailable:
      "Kalendar tidak dapat disemak sekarang. Saya telah minta seseorang membantu anda.",
    detailsInvalid:
      "Sila hantar nama kedai dan alamat, dipisahkan koma. Contoh: Kedai Pak Samad, Blok 824 #01-24. Anda juga boleh taip batal atau manusia.",
    cancelPrompt:
      "Batalkan lawatan ini? Masa anda kekal ditempah sehingga pembatalan disahkan.",
    cancelYes: "Batalkan lawatan",
    keep: "Kekalkan tempahan",
    kept: "Tempahan anda tidak berubah.",
    cancelPending:
      "Saya sedang membatalkan acara kalendar. Saya akan sahkan setelah selesai.",
    cancelled:
      "Tempahan dibatalkan. Taip TEMPAH untuk membuat tempahan baharu.",
    noBooking: "Anda tiada tempahan aktif. Taip TEMPAH untuk pilih masa.",
    alreadyBooked:
      "Anda sudah ada tempahan. Taip TUKAR MASA, BATAL, atau MANUSIA.",
    pending: "Tempahan sedang diproses. Taip MANUSIA jika perlu bantuan.",
    media:
      "Saya belum boleh membaca nota suara atau gambar. Sila taip permintaan atau MANUSIA.",
    faq: "Ledger membantu kedai mengatur pesanan stok melalui nota suara. Pembantu ini menempah lawatan pengenalan 20 minit. Seseorang boleh menjelaskan harga dan butiran perkhidmatan.",
    languageChanged:
      "Saya akan gunakan Bahasa Melayu. Taip TEMPAH atau MANUSIA.",
    chooseBook: "Tempah lawatan",
    chooseHuman: "Bercakap dengan orang",
  },
};
for (const lang of Object.keys(extras)) Object.assign(S[lang], extras[lang]);
