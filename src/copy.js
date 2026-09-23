import { cfg } from './config.js';

const NAME = cfg.owner.name;

/**
 * The poster QR prefills a message in the language of the poster they scanned,
 * so the first inbound message tells us which language to speak.
 */
export function detectLang(text = '') {
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/\b(saya|nampak|nak tahu|kedai|pembekal|lanjut|boleh)\b/i.test(text)) return 'ms';
  return 'en';
}

const S = {
  en: {
    listBody:
      `Thanks for messaging! ${NAME} here from Ledger.\n\n` +
      `I come by once for about 20 minutes, write down the suppliers you already use ` +
      `and the things you usually order. After that you just send one voice note when you need stock.\n\n` +
      `Pick a time that's quiet for you:`,
    listHeader: 'Book your 20 minutes',
    listButton: 'Pick a time',
    listSection: 'This week',
    slotDesc: n => `${n} min at your shop`,
    otherTime: 'Another time',
    otherTimeDesc: "Tell me what suits and I'll work around it",
    booked: iso =>
      `Booked: ${iso}. I'll come to you.\n\n` +
      `What's your shop name and unit number? (e.g. "Ah Seng Provisions, Blk 824 #01-24")`,
    saved:
      `Got it, thanks. See you then.\n\n` +
      `Nothing to prepare. If your supplier numbers are saved in your phone, that's all we need.\n\n` +
      `Any questions before that, just message here.`,
    handover: `Let me answer that myself rather than have a bot do it. ${NAME} here, I'll reply shortly.`,
    slotGone: `Sorry, someone just took that one. Here are the next times:`,
    noSlots:
      `I'd like to come by this week but my slots are full. ` +
      `Tell me which afternoon suits you and I'll make it work.`,
    notInterested: `No problem at all, thanks for letting me know. If you change your mind the number stays the same.`,
  },

  zh: {
    listBody:
      `谢谢你联系我们!我是 Ledger 的 ${NAME}。\n\n` +
      `我上门一次,大概二十分钟,把你现在用的供应商和常订的货记下来。之后你要补货,` +
      `只要发一段语音给我们就可以。\n\n` +
      `选一个你比较空的时间:`,
    listHeader: '预约二十分钟',
    listButton: '选时间',
    listSection: '这个星期',
    slotDesc: n => `上门 ${n} 分钟`,
    otherTime: '其他时间',
    otherTimeDesc: '告诉我你方便的时间,我配合你',
    booked: iso =>
      `已经约好:${iso}。我到时候过去。\n\n` +
      `请问你的店名和单位号是?(例如:发记杂货,824座 #01-24)`,
    saved:
      `收到,谢谢。到时候见。\n\n` +
      `不用准备什么。供应商的号码存在手机里就够了。\n\n` +
      `之前有什么问题,直接在这里问我。`,
    handover: `这个我自己回你比较好,不用机器人。我是 ${NAME},等下就回复你。`,
    slotGone: `不好意思,那个时段刚被约走了。这几个时间还可以:`,
    noSlots: `这个星期的时段满了。你讲一个方便的下午,我尽量配合。`,
    notInterested: `没问题,谢谢你告诉我。以后改变主意的话,号码还是这个。`,
  },

  ms: {
    listBody:
      `Terima kasih kerana menghubungi! Saya ${NAME} dari Ledger.\n\n` +
      `Saya datang sekali, lebih kurang 20 minit, untuk catat pembekal yang anda guna sekarang ` +
      `dan barang yang anda selalu pesan. Selepas itu anda hantar satu nota suara sahaja bila perlu stok.\n\n` +
      `Pilih masa yang lapang untuk anda:`,
    listHeader: 'Tempah 20 minit',
    listButton: 'Pilih masa',
    listSection: 'Minggu ini',
    slotDesc: n => `${n} minit di kedai anda`,
    otherTime: 'Masa lain',
    otherTimeDesc: 'Beritahu masa yang sesuai, saya ikut anda',
    booked: iso =>
      `Sudah ditempah: ${iso}. Saya datang ke kedai anda.\n\n` +
      `Apa nama kedai dan nombor unit anda? (cth. "Kedai Pak Samad, Blok 824 #01-24")`,
    saved:
      `Baik, terima kasih. Jumpa nanti.\n\n` +
      `Tiada apa nak sediakan. Kalau nombor pembekal ada dalam telefon anda, itu sudah cukup.\n\n` +
      `Ada soalan sebelum itu, terus mesej di sini.`,
    handover: `Biar saya jawab sendiri, bukan bot. Saya ${NAME}, saya balas sekejap lagi.`,
    slotGone: `Maaf, slot itu baru diambil orang. Ini masa yang masih ada:`,
    noSlots: `Slot minggu ini penuh. Beritahu petang mana yang sesuai, saya cuba sesuaikan.`,
    notInterested: `Tidak mengapa, terima kasih kerana beritahu. Kalau berubah fikiran, nombor ini sama.`,
  },
};

export const t = (lang, key) => (S[lang] ?? S.en)[key] ?? S.en[key];
