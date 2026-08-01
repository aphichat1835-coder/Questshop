
const { EmbedBuilder } = require('discord.js');

// สีแอพต่างๆ ปรับเปลี่ยนได้ตามใจ (ถ้าต้องการ)
const youtube = '#FF0000';
const netflix = '#E50914';
const iqiyi = '#00BE06';
const bilibili = '#00A1D6';
const viu = '#FDD000';
const wetv = '#00DDB3';
const disneyplus = '#113CCF';
const monomax = '#FF6600';
const hbomax = '#5B00A7';
const ch3plus = '#EC1C24';
const amazonprimevideo = '#00A8E1';
const trueidplus = '#E1251B';
const youku = '#FF4E69';
const oned = '#F68B1E';
const crunchyroll = '#F47521';

// อิโมจิแอพต่างๆ (จำเป็นต้องแก้ให้เป็นของคุณเองนะครับ ใช้จากเซิฟเวอร์ของคุณเอง <:emoji:55555> )
const youtube_emoji = '<:youtube:1430376476561248277>';
const netflix_emoji = '<:netflix:1430376467380048003>';
const iqiyi_emoji = '<:iQ:1430376438690742292>';
const bilibili_emoji = '<:Bi:1430376424094695604>';
const viu_emoji = '<:VI:1430376434169417801>';
const wetv_emoji = '<:We:1430376495372697620>';
const disneyplus_emoji = '<:Di:1430376499873321001>';
const monomax_emoji = '<:monomax:1430376481179173007>';
const hbomax_emoji = '<:HB:1430376491077730314>';
const ch3plus_emoji = '<:CH:1430376471972806716>';
const amazonprimevideo_emoji = '<:Am:1430376463030292510>';
const trueidplus_emoji = '<:Tr:1430376445372403742>';
const youku_emoji = '<:n_:1430376455061377024>';
const oned_emoji = '<:on:1430376429480181781>';
const crunchyroll_emoji = '<:crun:1431041450812117124>'; // แก้ให้เป็นอิโมจิของคุณเอง

// รายละเอียดสินค้าจ่างงๆ ยาวจัด ขยันหน่อยนะครับ
const productDetails = {
    youtube_premium_myemail_30d: {
        title: 'YouTube Premium /30วัน (เมลตัวเอง)',
        color: youtube,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380086921531573/youtube.png?ex=68f990c3&is=68f83f43&hm=2371a86552efcf95fbe7c870b4279d57e32ce3985f69383c28e4787f656eafa5&',
        description: `## ${youtube_emoji} Youtube Premium/30วัน (เมลตัวเอง)\n• **️ รับชม Youtube แบบไม่มีโฆษณาคั่น**\n• **️ ฟังเพลง Youtube Music แบบปิดหน้าจอได้**\n• **️ ดาวน์โหลดเพลงหรือบันทึกวิดีโอเล่นแบบออฟไลน์**\n• **️ จะได้รับเป็น ลิ้งคำเชิญ family เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ Youtube Premiumแพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.youtube.com/)`,
        category: 'youtube',
        appEmoji: youtube_emoji
    },
    youtube_premium_shopemail_30d: {
        title: 'YouTube Premium /30วัน (เมลร้าน)',
        color: youtube,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380086921531573/youtube.png?ex=68f990c3&is=68f83f43&hm=2371a86552efcf95fbe7c870b4279d57e32ce3985f69383c28e4787f656eafa5&',
        description: `## ${youtube_emoji} Youtube Premium/30วัน (เมลร้าน)\n• **️ รับชม Youtube แบบไม่มีโฆษณาคั่น**\n• **️ ฟังเพลง Youtube Music แบบปิดหน้าจอได้**\n• **️ ดาวน์โหลดเพลงหรือบันทึกวิดีโอเล่นแบบออฟไลน์**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ Youtube Premiumแพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.youtube.com/)`,
        category: 'youtube',
        appEmoji: youtube_emoji
    },
    netflix_4k_private_1d: {
        title: 'Netflix 4K /1วัน (จอส่วนตัว)',
        color: netflix,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380131926540308/netflix.png?ex=68f990ce&is=68f83f4e&hm=debe93fb7f7748e91488d8a477557047addf969449299486e41c5702ac69f557&',
        description: `## ${netflix_emoji} Netflix 4K /1วัน (จอส่วนตัว)\n**\`\`\`[🚨]️ ️กรณีบัญชีโดนปิดจากทาง Netflix จะไม่รับเคลมทุกกรณี เนื่องจากการหารหรือแชร์รหัสร่วมกัน ซึ่งขัดต่อกฎการใช้งานของ Netflix ที่ระบุไว้ หากท่านต้องการซื้อสินค้ากรุณารับความเสียง\`\`\`**\n• **️ Netflix แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ UltraHD 4K**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ แอคเคาท์ไทยแท้100%**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับอุปกรณ์ (Com, Ipad ,มือถือ)**\n• **️ Netflixแพ็กเกจ UltraHD 4K 1วัน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.netflix.com/)`,
        category: 'netflix',
        appEmoji: netflix_emoji
    },
    netflix_4k_tv_private_1d: {
        title: 'Netflix 4K /1วัน (TV) (จอส่วนตัว)',
        color: netflix,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380131926540308/netflix.png?ex=68f990ce&is=68f83f4e&hm=debe93fb7f7748e91488d8a477557047addf969449299486e41c5702ac69f557&',
        description: `## ${netflix_emoji} Netflix 4K /1วัน (TV) (จอส่วนตัว)\n**\`\`\`[🚨]️ ️กรณีบัญชีโดนปิดจากทาง Netflix จะไม่รับเคลมทุกกรณี เนื่องจากการหารหรือแชร์รหัสร่วมกัน ซึ่งขัดต่อกฎการใช้งานของ Netflix ที่ระบุไว้ หากท่านต้องการซื้อสินค้ากรุณารับความเสียง\`\`\`**\n• **️ Netflix แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ UltraHD 4K**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ แอคเคาท์ไทยแท้100%**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ Netflixแพ็กเกจ UltraHD 4K 1วัน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.netflix.com/)`,
        category: 'netflix',
        appEmoji: netflix_emoji
    },
    netflix_4k_tv_private_7d: {
        title: 'Netflix 4K /7วัน (TV) (จอส่วนตัว)',
        color: netflix,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380131926540308/netflix.png?ex=68f990ce&is=68f83f4e&hm=debe93fb7f7748e91488d8a477557047addf969449299486e41c5702ac69f557&',
        description: `## ${netflix_emoji} Netflix 4K /7วัน (TV) (จอส่วนตัว)\n**\`\`\`[🚨]️ ️กรณีบัญชีโดนปิดจากทาง Netflix จะไม่รับเคลมทุกกรณี เนื่องจากการหารหรือแชร์รหัสร่วมกัน ซึ่งขัดต่อกฎการใช้งานของ Netflix ที่ระบุไว้ หากท่านต้องการซื้อสินค้ากรุณารับความเสียง\`\`\`**\n• **️ Netflix แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ UltraHD 4K**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ แอคเคาท์ไทยแท้100%**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ Netflixแพ็กเกจ UltraHD 4K 7วัน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.netflix.com/)`,
        category: 'netflix',
        appEmoji: netflix_emoji
    },
    netflix_4k_private_30d: {
        title: 'Netflix 4K /30วัน (จอส่วนตัว)',
        color: netflix,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380131926540308/netflix.png?ex=68f990ce&is=68f83f4e&hm=debe93fb7f7748e91488d8a477557047addf969449299486e41c5702ac69f557&',
        description: `## ${netflix_emoji} Netflix 4K /30วัน (จอส่วนตัว)\n**\`\`\`[🚨]️ ️กรณีบัญชีโดนปิดจากทาง Netflix จะไม่รับเคลมทุกกรณี เนื่องจากการหารหรือแชร์รหัสร่วมกัน ซึ่งขัดต่อกฎการใช้งานของ Netflix ที่ระบุไว้ หากท่านต้องการซื้อสินค้ากรุณารับความเสียง\`\`\`**\n• **️ Netflix แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ UltraHD 4K**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ แอคเคาท์ไทยแท้100%**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับอุปกรณ์ (Com, Ipad ,มือถือ)**\n• **️ Netflixแพ็กเกจ UltraHD 4K รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.netflix.com/)`,
        category: 'netflix',
        appEmoji: netflix_emoji
    },
    netflix_4k_tv_private_30d: {
        title: 'Netflix 4K /30วัน (TV) (จอส่วนตัว)',
        color: netflix,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380131926540308/netflix.png?ex=68f990ce&is=68f83f4e&hm=debe93fb7f7748e91488d8a477557047addf969449299486e41c5702ac69f557&',
        description: `## ${netflix_emoji}  Netflix 4K /30วัน (TV) (จอส่วนตัว)\n**\`\`\`[🚨]️ ️กรณีบัญชีโดนปิดจากทาง Netflix จะไม่รับเคลมทุกกรณี เนื่องจากการหารหรือแชร์รหัสร่วมกัน ซึ่งขัดต่อกฎการใช้งานของ Netflix ที่ระบุไว้ หากท่านต้องการซื้อสินค้ากรุณารับความเสียง\`\`\`**\n• **️ Netflix แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ UltraHD 4K**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ แอคเคาท์ไทยแท้100%**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ Netflixแพ็กเกจ UltraHD 4K รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.netflix.com/)`,
        category: 'netflix',
        appEmoji: netflix_emoji
    },
    iqiyi_gold_30d: {
        title: 'iQIYI Gold /30วัน',
        color: iqiyi,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380184371986452/iQ.png?ex=68f990db&is=68f83f5b&hm=8bf41323ab5194f6a53cc317af5b77e895218a614f5cb399187aea1bd3ea61a6&',
        description: `## ${iqiyi_emoji} iQIYI GOLD /30วัน\n• **️ iQIYI แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ รับชม iqiyi VIP แบบไม่มีโฆษณาคั่น**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ iQIYI VIP แพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.iq.com/)`,
        category: 'iqiyi',
        appEmoji: iqiyi_emoji
    },
    bilibili_30d: {
        title: 'Bilibili /30วัน',
        color: bilibili,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380248767398029/Bi.png?ex=68f990ea&is=68f83f6a&hm=320a82a6d7121bef37497998859fae8bedb24c42fee2e83b3e85253963daa1bb&',
        description: `## ${bilibili_emoji}  Bilibili /30วัน\n• **️ Bilibili แอปดูการ์ตูนอนิเมะ**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ Bilibili แพ็กเกจ Premium รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.bilibili.tv/th)`,
        category: 'bilibili',
        appEmoji: bilibili_emoji
    },
    viu_premium_7d: {
        title: 'VIU Premium /7วัน',
        color: viu,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380306107596851/VI.png?ex=68f990f8&is=68f83f78&hm=82e3f5708af5f3de71d9b1bfcdcbeeb90687ce9e53d44536bdca81debb8a54ef&',
        description: `## ${viu_emoji} VIU Premium/7วัน\n• **️ VIU แอปดูหนัง/ซีรีย์**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ รับชม VIU Premium แบบไม่มีโฆษณาคั่น**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ VIU Premiumแพ็กเกจ 7วัน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.viu.com/)`,
        category: 'viu',
        appEmoji: viu_emoji
    },
    viu_premium_30d: {
        title: 'VIU Premium /30วัน',
        color: viu,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380306107596851/VI.png?ex=68f990f8&is=68f83f78&hm=82e3f5708af5f3de71d9b1bfcdcbeeb90687ce9e53d44536bdca81debb8a54ef&',
        description: `## ${viu_emoji}  VIU Premium/30วัน\n• **️ VIU แอปดูหนัง/ซีรีย์**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ รับชม VIU Premium แบบไม่มีโฆษณาคั่น**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ VIU Premiumแพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.viu.com/)`,
        category: 'viu',
        appEmoji: viu_emoji
    },
    wetv_vip_30d: {
        title: 'WeTV VIP /30วัน',
        color: wetv,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380352786141345/We.png?ex=68f99103&is=68f83f83&hm=d327360ccac158ef725993367cd0ae1ab2fc59942331b600bd874d80047d5c75&',
        description: `## ${wetv_emoji}  WeTV VIP /30วัน\n• **️ WeTV แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ รับชม WeTV VIP แบบไม่มีโฆษณาคั่น**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ WeTV VIP แพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://wetv.vip/)`,
        category: 'wetv',
        appEmoji: wetv_emoji
    },
    disneyplus_private_alldevice_30d: {
        title: 'Disney+ /30วัน (จอส่วนตัว) (ทุกอุปกรณ์)',
        color: disneyplus,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380406951116901/Di.png?ex=68f99110&is=68f83f90&hm=777b52dc9700f0c30f1a3e13710f62ca922a5fe861cd005a57ccfb4ae2b4b0e3&',
        description: `## ${disneyplus_emoji} Disney+ /30วัน (จอส่วนตัว) (ทุกอุปกรณ์)\n• **️ Disney+ แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD 4K**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ จะได้รับเป็น Phone/OTP เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ Disney แพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.hotstar.com/th)`,
        category: 'disney',
        appEmoji: disneyplus_emoji
    },
    monomax_private_30d: {
        title: 'MONOMAX /30วัน (จอส่วนตัว)',
        color: monomax,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380491441180722/monomax.png?ex=68f99124&is=68f83fa4&hm=27aca1b97d1f84c99c5ac4050965090329a08c4c4cf71abc4245bd14765a2c51&',
        description: `## ${monomax_emoji}  MONOMAX/30วัน (จอส่วนตัว)\n• **️ MONOMAX แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ MONOMAX แพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.monomax.me/)`,
        category: 'monomax',
        appEmoji: monomax_emoji
    },
    monomax_private_premierleague_30d: {
        title: 'MONOMAX /30วัน (จอส่วนตัว + พรีเมียร์ลีก)',
        color: monomax,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430380491441180722/monomax.png?ex=68f99124&is=68f83fa4&hm=27aca1b97d1f84c99c5ac4050965090329a08c4c4cf71abc4245bd14765a2c51&',
        description: `## ${monomax_emoji}  MONOMAX/30วัน (จอส่วนตัว + พรีเมียร์ลีก)\n• **️ MONOMAX แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ MONOMAX แพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.monomax.me/)`,
        category: 'monomax',
        appEmoji: monomax_emoji
    },
    hbomax_hd_private_30d: {
        title: 'HBO Max /30วัน (HD) (จอส่วนตัว)',
        color: hbomax,
        thumbnail: 'https://cdn.discordapp.com/ephemeral-attachments/1423628357966368842/1430380940202610759/HB.png?ex=68f9918f&is=68f8400f&hm=96dfc162766f48098d59e327219dd8e0ce8dc7e7424fafa7eeb89c43b5dae16a&',
        description: `## ${hbomax_emoji} HBO MAX/30วัน (HD) (จอส่วนตัว)\n• **️ HBO MAX แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ HBO MAX แพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.max.com/)`,
        category: 'hbomax',
        appEmoji: hbomax_emoji
    },
    hbomax_4k_private_30d: {
        title: 'HBO Max /30วัน (4K) (จอส่วนตัว)',
        color: hbomax,
        thumbnail: 'https://cdn.discordapp.com/ephemeral-attachments/1423628357966368842/1430380940202610759/HB.png?ex=68f9918f&is=68f8400f&hm=96dfc162766f48098d59e327219dd8e0ce8dc7e7424fafa7eeb89c43b5dae16a&',
        description: `## ${hbomax_emoji} HBO MAX/30วัน (4K) (จอส่วนตัว)\n• **️ HBO MAX แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ 4K**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ HBO MAX แพ็กเกจ จัมโบ้ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.max.com/)`,
        category: 'hbomax',
        appEmoji: hbomax_emoji
    },
    ch3plus_share_30d: {
        title: 'CH3 Plus /30วัน (จอแชร์)',
        color: ch3plus,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430381121790804108/CH.png?ex=68f991ba&is=68f8403a&hm=5b1f97073e4c2bc3353e545731a6e81cb44028e7908f268774ac59a9b57fef5c&',
        description: `## ${ch3plus_emoji} CH3 Plus /30วัน (จอแชร์)\n• **️ CH3 Plus แอปดูภาพยนตร์ / ซีรีส์ / ละคร การ์ตูน / ข่าวสด ย้อนหลัง**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ CH3 Plus แพ็กเกจ Premium รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://ch3plus.com/)`,
        category: 'ch3 plus',
        appEmoji: ch3plus_emoji
    },
    ch3plus_private_30d: {
        title: 'CH3 Plus /30วัน (จอส่วนตัว)',
        color: ch3plus,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430381121790804108/CH.png?ex=68f991ba&is=68f8403a&hm=5b1f97073e4c2bc3353e545731a6e81cb44028e7908f268774ac59a9b57fef5c&',
        description: `## ${ch3plus_emoji}  CH3 Plus /30วัน (จอส่วนตัว)\n• **️ CH3 Plus แอปดูภาพยนตร์ / ซีรีส์ / ละคร การ์ตูน / ข่าวสด ย้อนหลัง**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ CH3 Plus แพ็กเกจ Premium รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://ch3plus.com/)`,
        category: 'ch3 plus',
        appEmoji: ch3plus_emoji
    },
    amazonprimevideo_30d: {
        title: 'Amazon Prime Video /30วัน',
        color: amazonprimevideo,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430381181962031136/Am.png?ex=68f991c8&is=68f84048&hm=8944192d0d242f643e9313746f23a25a7dbbea39aa122793d9bbdc51b69f4d7a&',
        description: `## ${amazonprimevideo_emoji}  Amazon Prime Video/30วัน\n• **️ Amazon Prime Video แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ Amazon Prime Video แพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.primevideo.com/)`,
        category: 'amazon prime video',
        appEmoji: amazonprimevideo_emoji
    },
    trueidplus_30d: {
        title: 'TrueID+ /30วัน',
        color: trueidplus,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430381230880460800/Tr.png?ex=68f991d4&is=68f84054&hm=fa6d73424e8fdae21e5a7c4c487acd2c3059f894db65d49d826f5362710fdc11&',
        description: `## ${trueidplus_emoji} TrueID+ /30วัน\n• **️ TrueID แอปดูหนังภาพยนตร์/ซีรีย์/การ์ตูน/TVออนไลน์**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ รับชม TrueID+ แบบไม่มีโฆษณาคั่น**\n• **️ จะได้รับเป็น Phone/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ TrueID แพ็กเกจ TrueID+ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.trueid.net/watch/th-th/trueidplus)`,
        category: 'trueid',
        appEmoji: trueidplus_emoji
    },
    youku_vip_30d: {
        title: 'YOUKU VIP /30วัน',
        color: youku,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430381290573660271/n.png?ex=68f991e2&is=68f84062&hm=5d3279291cf941cf2c3b4d6985187c9e672d71d1733d33da1e58759d5c6f6517&',
        description: `## ${youku_emoji} YOUKU VIP /30วัน\n• **️ YOUKU แอปดูหนัง/ซีรีย์**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ รับชม YOUKU Premium แบบไม่มีโฆษณาคั่น**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ YOUKU Premium แพ็กเกจ รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://youku.tv/)`,
        category: 'youku',
        appEmoji: youku_emoji
    },
    oned_30d: {
        title: 'oneD /30วัน',
        color: oned,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1430381330419683410/on.png?ex=68f991ec&is=68f8406c&hm=d9c72996bc3b258ab742ce3eb466742d8e8d8e36db59fea60c771727042d7d1d&',
        description: `## ${oned_emoji} oneD /30วัน\n• **️ oneD แอปดูภาพยนตร์ / ซีรีส์ / ละคร การ์ตูน / ข่าวสด ย้อนหลัง**\n• **️ Soundเสียง พากย์ไทย/ซับไทย**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 1จอ**\n• **️ รับชม oneD แบบไม่มีโฆษณาคั่น**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ oneD แพ็กเกจ Premium รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.oned.net/)`,
        category: 'oned',
        appEmoji: oned_emoji
    },
    crunchyroll_premium_30d: {
        title: 'Crunchyroll Premium /30วัน',
        color: crunchyroll,
        thumbnail: 'https://cdn.discordapp.com/attachments/1373550875435470869/1431042775444357312/crunchyroll.png?ex=68fbf9f1&is=68faa871&hm=4bc3c0d34dd352459b3fa513bf4cbdc6a949035c403bffca561bd5588a9aba40',
        description: `## ${crunchyroll_emoji} Crunchyroll Premium /30วัน\n• **️ Crunchyroll แอปดูอนิเมะ มังงะ**\n• **️ Soundเสียง พากย์ไทย/ซับไทย/ญี่ปุ่น**\n• **️ ความชัดระดับ Full HD**\n• **️ สามารถรับชมจำนวน 4จอ**\n• **️ รับชม Crunchyroll แบบไม่มีโฆษณาคั่น**\n• **️ จะได้รับเป็น Email/Password เข้าใช้งานได้ทันที**\n• **️ รองรับทุกอุปกรณ์ (TV,Com, Ipad ,มือถือ)**\n• **️ Crunchyroll แพ็กเกจ Premium รายเดือน**\n### 🌎 เว็ปไซต์ [แอพพรีเมียม](https://www.crunchyroll.com/)`,
        category: 'crunchyroll',
        appEmoji: crunchyroll_emoji
    }
};

function createProductDetailEmbed(productKey, stock, price) {
    const detail = productDetails[productKey];
    if (!detail) return null;

    const stockEmoji = stock > 0 ? '✔️' : '❌';
    
    return new EmbedBuilder()
        .setThumbnail(detail.thumbnail)
        .setColor(detail.color)
        .setDescription(detail.description)
        .addFields(
            {
                name: '``💰`` ราคาสินค้า',
                value: `**\`\`\`${price.toFixed(2)} บาท\`\`\`**`,
                inline: true
            },
            {
                name: `\`\`${stockEmoji}\`\` สต๊อกคงเหลือ`,
                value: `**\`\`\`${stock} ชิ้น\`\`\`**`,
                inline: true
            }
        )
        .setFooter({ text: `หมวดหมู่สินค้า: ${detail.category}︲${detail.title}`, iconURL: `${detail.thumbnail}` });
}

module.exports = { createProductDetailEmbed, productDetails };
