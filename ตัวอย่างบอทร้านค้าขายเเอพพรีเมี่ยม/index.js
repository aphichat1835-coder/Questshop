
// ==============================================

// 🎬 บอทขายแอพพรีเมี่ยมจัดการสต๊อกเอง
// 💚 By. @lemonade_isgod

// ❌ ขอความกรุณาไม่นำโค้ดไปรีสกินแล้วขายเป็นของตัวเองนะครับ
// 🙏🏻 เห็นใจคนทำแจกด้วยน้าา 💝

// แนะนำให้เช็คดูไฟล์ต่างๆให้ครบก่อนใช้เปิดใช้งานนะค่าบบบบเผื่อต้องแก้ข้อมูลบางอัน

// ==============================================

// 📦 ติดตั้ง Module ต่างๆ: npm i discord.js cloudscraper

// 🤖 คำสั่งบอท มี 6 คำสั่งของแอดมิน:
// 1. /ติดตั้งเมนูขายแอพพรีเมี่ยม
// 2. /จัดการยอดเงินผู้ใช้
// 3. /เช็คยอดเงินผู้ใช้
// 4. /อัพโหลดสต๊อกสินค้า
// 5. /ตั้งราคาสินค้า
// 6. /ล้างสต๊อกสินค้าทั้งหมด

// ==============================================

// [Discord] credit dev: @lemonade_isgod
// pls dont selling this src codes

// ==============================================


const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    StringSelectMenuBuilder, 
    ButtonStyle, 
    REST, 
    Routes,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const TopupSystem = require('./topup/topup_trueWallet');
const Logger = require('./logger');
const { adminCommands, handleAdminCommands } = require('./admin_commands');
const { createProductDetailEmbed, productDetails } = require('./product/product_detail');



const TOKEN = 'MTQzMDE3NDA5MjUwNTY0OTMwNQ...'; // โทเค่นบอท
const ADMIN_IDS = ['1352630562812067930']; // USER ID ไอดีแอดมินคนใช้คำสั่งได้
const PHONE = '064xxxxxxx'; // เบอร์วอเลทของคุณ true money wallet 
const TOPUP_LOG_CHANNEL_ID = '1430426390687256598'; // ช่อง log แจ้งเตือนเติมเงิน
const BUY_LOG_CHANNEL_ID = '1430426390687256598'; // ช่อง log แจ้งเตือนซื้อสินค้า
const LOG_ADMIN_CHANNEL_ID = '1430426390687256598'; // ช่อง log แจ้งเตือนจัดการยอดเงินของแอดมิน (เป็นหลังบ้าน)
const LOG_ADDSTOCK_CHANNEL_ID = '1430426390687256598'; // ช่อง log แจ้งเตือนเติมสต๊อกสินค้า (ไว้หลังบ้านก็ได้ ถ้าต้องการ)

module.exports = { ADMIN_IDS };

const topupSystem = new TopupSystem({
    phoneNumber: PHONE,
    databasePath: './data'
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});


function sortProductsByStock(products) {
    const entries = Object.entries(products);
    entries.sort((a, b) => b[1].stock - a[1].stock);
    return entries.map(([key]) => key);
}

function getTotalStock(products) {
    return Object.values(products).reduce((total, product) => total + product.stock, 0);
}

async function createShopMenu() {
    const stock = await loadProductStock();
    const sortedProducts = sortProductsByStock(stock);
    const totalStock = getTotalStock(stock);
    
    const halfPoint = Math.ceil(sortedProducts.length / 2);
    const row1Products = sortedProducts.slice(0, halfPoint);
    const row2Products = sortedProducts.slice(halfPoint);

    const embed = new EmbedBuilder()
        .setTitle('``💚`` 𝗟𝗘𝗠𝗢𝗡 𝗦𝗛𝗢𝗣 𝗔𝗣𝗣 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 𝗔𝗨𝗧𝗢')
        .setColor('#E50914')
        .setDescription(`**\`\`\`🎬 • เลือกแอพพรีเมียมที่ต้องการ\n📦 • มีสินค้าพร้อมขาย ${totalStock} ชิ้น\`\`\`**`)
        .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1430411457207603312/Background-size1920x1080-4e1694a6-75aa-4c36-9d4d-7fb6a3102005-bc5318781aad7f5c8520.png?ex=68f9adfb&is=68f85c7b&hm=ed792f047b53ef5170d612b9614ba0297e51a9c06032b885b7064fbb5e7b46b3&')
        .setFooter({ text: '🎬 𝗕𝗨𝗬 𝗔𝗣𝗣 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 𝗔𝗨𝗧𝗢' });

    const createSelectOptions = (productKeys) => {
        return productKeys.map(key => {
            const product = stock[key];
            const detail = productDetails[key];
            const stockEmoji = product.stock > 0 ? '✔️' : '❌';
            
            return {
                label: detail?.title || key,
                description: `💰ราคา ${product.price.toFixed(2)} บาท︲${stockEmoji}คงเหลือ ${product.stock} ชิ้น`,
                value: key,
                emoji: detail?.appEmoji || undefined
            };
        });
    };

    // 🔰 พวกลิสต์แอพ สต๊อกไหนเยอะสุด มันจะย้ายตำแหน่งมาอยู่ หมดวที่ 1 อัติโนมัติ ตรงตัวเลือกบนๆสุด ตามลำดับ อันไหนเยอะสุด (เห็นผลเมื่อกด ล้างตัวเลือกใหม่)
    // ถ้าไม่มีสักสต๊อก ก็จะอยู่ประจำตำแหน่งเดิม
    const selectMenu1 = new StringSelectMenuBuilder()
        .setCustomId('app_select_row1')
        .setPlaceholder('|︲🎬 เลือกแอพที่ต้องการหมวดที่ 1︲|')
        .addOptions([
            ...createSelectOptions(row1Products),
            {
                label: 'ล้างตัวเลือกใหม่',
                emoji: '<:Ldelete:1387382890781999115>',
                value: 'refresh_menu'
            }
        ]);

    const selectMenu2 = new StringSelectMenuBuilder()
        .setCustomId('app_select_row2')
        .setPlaceholder('|︲🎬 เลือกแอพที่ต้องการหมวดที่ 2︲|')
        .addOptions([
            ...createSelectOptions(row2Products),
            {
                label: 'ล้างตัวเลือกใหม่',
                emoji: '<:Ldelete:1387382890781999115>',
                value: 'refresh_menu'
            }
        ]);

    const buttons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('topup_money')
                .setLabel('『 เติมเงินเข้าสู่ระบบ 』')
                .setStyle(ButtonStyle.Success)
                .setEmoji('<a:BitCoin:1407944663780032543>'),
            new ButtonBuilder()
                .setCustomId('check_balance')
                .setLabel('『 เช็คยอดเงินคงเหลือ 』')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('<:UN145:1407344712221855855>')
        );

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(selectMenu1),
            new ActionRowBuilder().addComponents(selectMenu2),
            buttons
        ]
    };
}

function createTopupMenu() {
    const embed = new EmbedBuilder()
        .setTitle('``💰`` เติมเงินเข้าสู่ระบบ')
        .setImage('https://s14.gifyu.com/images/bK9Q5.png');
    
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('topup_method')
        .setPlaceholder('|︲💰 เลือกวิธีการเติมเงิน︲|')
        .addOptions([
            {
                label: 'ซองอั่งเปา TrueMoney Wallet',
                emoji: '🧧',
                description: '🧧︲เติมเงินผ่านซองอั่งเปาเงินเข้าทันที',
                value: 'truemoney_gift'
            },
            {
                label: 'ล้างตัวเลือกใหม่',
                emoji: '<:Ldelete:1387382890781999115>',
                value: 'refresh_topup'
            }
        ]);

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(selectMenu)]
    };
}



function getThaiDateTime() {
    const now = new Date();
    return now.toLocaleTimeString('th-TH', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'Asia/Bangkok',
        calendar: 'gregory'
    });
}


async function loadProductStock() {
    try {
        const data = await fs.readFile(path.join(__dirname, 'product', 'product_stock.json'), 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading product stock:', error);
        return {};
    }
}

async function saveProductStock(stock) {
    try {
        await fs.writeFile(
            path.join(__dirname, 'product', 'product_stock.json'),
            JSON.stringify(stock, null, 4),
            'utf8'
        );
    } catch (error) {
        console.error('Error saving product stock:', error);
    }
}

async function getTotalSoldCount() {
    try {
        const stock = await loadProductStock();
        return Object.values(stock).reduce((total, product) => total + (product.sold || 0), 0);
    } catch (error) {
        console.error('Error getting total sold count:', error);
        return 0;
    }
}

client.once('clientReady', async () => {
   // console.clear();
    console.log('\n');
    console.log('═══════════════════════════════════════════════');
    console.log('🎬 𝗕𝗨𝗬 𝗔𝗣𝗣 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 𝗔𝗨𝗧𝗢');
    console.log(`🤖 𝗕𝗢𝗧: ${client.user.tag}`);
    console.log('💚 𝗦𝗧𝗔𝗧𝗨𝗦: 𝗢𝗡𝗟𝗜𝗡𝗘');

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: adminCommands }
        );

        console.log('✔️ 𝗖𝗠𝗗 𝗥𝗘𝗚𝗜𝗦𝗧𝗘𝗥: 𝗬𝗘𝗦');
    } catch (error) {
        console.log('❌ 𝗖𝗠𝗗 𝗥𝗘𝗚𝗜𝗦𝗧𝗘𝗥: 𝗡𝗢');
        console.error('[ERROR] ❌ เกิดข้อผิดพลาด REGISTER:', error.message);
    }
    
    console.log('═══════════════════════════════════════════════');
    console.log('\n');
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'ติดตั้งเมนูขายแอพพรีเมี่ยม') {
                if (!ADMIN_IDS.includes(interaction.user.id)) {
                    const noPerm = new EmbedBuilder()
            .setTitle('``❌`` ไม่มีสิทธิ์')
            .setDescription('```❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้```')
            .setColor('#FF0000')
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');
                    return interaction.reply({ embeds: [noPerm] , ephemeral: true });
                }

                const channel = interaction.options.getChannel('ช่อง');
                const menuData = await createShopMenu();

                await channel.send(menuData);
                const sent = new EmbedBuilder()
                .setTitle(`\`\`✅\`\` ติดตั้งเมนูสำเร็จใน ${channel}`)
                .setColor(0x00FF00);
                await interaction.reply({ embeds: [sent], ephemeral: true });
            } else {
                const topupChannel = client.channels.cache.get(TOPUP_LOG_CHANNEL_ID);
                const adminLogChannel = client.channels.cache.get(LOG_ADMIN_CHANNEL_ID);
                const addStockLogChannel = client.channels.cache.get(LOG_ADDSTOCK_CHANNEL_ID);
                await handleAdminCommands(interaction, topupSystem, topupChannel, adminLogChannel, addStockLogChannel, ADMIN_IDS);
            }
        }

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'app_select_row1' || interaction.customId === 'app_select_row2') {
                const selected = interaction.values[0];

                if (selected === 'refresh_menu') {
                    const menuData = await createShopMenu();
                    await interaction.update(menuData);
                    return;
                }

                const stock = await loadProductStock();
                const product = stock[selected];
                const detail = productDetails[selected];

                if (!product || !detail) {
                    await interaction.deferReply({ ephemeral: true });
                    const noFound = new EmbedBuilder()
                    .setTitle('``❌`` ไม่พบสินค้าที่เลือก')
                    .setColor(0xFF0000)
                    .setDescription('```❌ ไม่พบสินค้านี้ กรุณาติดต่อแอดมิน```')
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');
                    return interaction.editReply({ embeds: [noFound], ephemeral: true });
                }

                const embed = createProductDetailEmbed(selected, product.stock, product.price);
                
                const confirmButton = new ButtonBuilder()
                    .setCustomId(`buy_product:${selected}`)
                    .setLabel('︲✅︲ยืนยันสั่งซื้อแอพ')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(product.stock === 0);

                const row = new ActionRowBuilder().addComponents(confirmButton);

                await interaction.deferReply({ ephemeral: true });
                await interaction.editReply({ embeds: [embed], components: [row], ephemeral: true });
            }

            if (interaction.customId === 'topup_method') {
                const method = interaction.values[0];

                if (method === 'refresh_topup') {
                    const menuData = createTopupMenu();
                    await interaction.update(menuData);
                    return;
                }

                if (method === 'truemoney_gift') {
                    const modal = new ModalBuilder()
                        .setCustomId('topup_truemoney_modal')
                        .setTitle('🧧 : เติมเงินด้วยซองอั่งเปา');

                    const linkInput = new TextInputBuilder()
                        .setCustomId('gift_link')
                        .setLabel('🎋 : ลิงก์ซองอั่งเปาวอเลท')
                        .setPlaceholder('https://gift.truemoney.com/campaign/?v=xxxxxxxxxxxxxxxx')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    modal.addComponents(new ActionRowBuilder().addComponents(linkInput));
                    await interaction.showModal(modal);
                }
            }
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'topup_money') {
                const menuData = createTopupMenu();
                await interaction.deferReply({ ephemeral: true });
                await interaction.editReply({ 
                    ...menuData,
                    ephemeral: true 
                });
            }

            if (interaction.customId === 'check_balance') {
                const userData = await topupSystem.getUserData(interaction.user.id);
                
                const loading = new EmbedBuilder()
                    .setTitle('``💳`` กำลังเช็คยอดเงิน...')
                    .setColor('#0099ff');
                await interaction.reply({ embeds: [loading], ephemeral: true });
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const embed = new EmbedBuilder()
                    .setAuthor({ name: `︲${interaction.user.username.split('_').map(word => word.toUpperCase()).join('_')}︲`,
                        iconURL: `${interaction.user.displayAvatarURL({ dynamic: true })}` 
                        })
                    .setDescription(`\`\`\`💰 ยอดเงินคงเหลือ: ${userData.point.toFixed(2)} THB\`\`\``)
                    .setColor(0x00FF00)
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

                await interaction.editReply({ embeds: [embed] });
            }

            if (interaction.customId.startsWith('buy_product:')) {
                const productKey = interaction.customId.split(':')[1];
                const stock = await loadProductStock();
                const product = stock[productKey];
                const detail = productDetails[productKey];

                if (!product || product.stock === 0) {
                    await interaction.deferReply({ ephemeral: true });
                    const noStock = new EmbedBuilder()
                    .setTitle('``❌`` สินค้ามีไม่เพียงพอ')
                    .setColor(0xFF0000)
                    .setDescription('```❌ สินค้านี้หมดสต๊อก กรุณารอแอดมินเติมสต๊อก```')
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');
                    return interaction.editReply({ embeds: [noStock], ephemeral: true });
                }

                const userData = await topupSystem.getUserData(interaction.user.id);

                if (userData.point < product.price) {
                    await interaction.deferReply({ ephemeral: true });
                    const noEnough = new EmbedBuilder()
                    .setTitle('``❌`` ยอดเงินไม่เพียงพอ')
                    .setColor(0xFF0000)
                    .setDescription('```❌ ยอดเงินของคุณไม่พอจะทำรายการ!```')
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');
                    return interaction.editReply({ 
                        embeds: [noEnough], 
                        ephemeral: true 
                    });
                }

                const account = product.accounts.shift();
                product.stock = product.accounts.length;
                product.sold++;

                await topupSystem.addPointsToUser(interaction.user.id, -product.price);
                await saveProductStock(stock);

                const totalSold = await getTotalSoldCount();
                const thaiTime = getThaiDateTime();

                try {
                    const dmEmbed = new EmbedBuilder()
                        .setTitle('``🎬`` คำสั่งซื้อแอพพรีเมี่ยมสำเร็จ')
                        .setDescription(detail.description)
                        .setColor(`${detail.color}`)
                        .addFields(
                            { name: '``✅`` ข้อมูลการสั่งซื้อ',
                              value: 
                                  `**\`\`\`💬 รหัสสินค้า: ${totalSold}\n` +
            `🎬 ชื่อสินค้า: ${detail.title.toUpperCase()}\n` +
            `📆 วันที่︲เวลา: ${thaiTime}\`\`\`**` , inline: true
                            },
                            { name: '``📦`` สินค้าที่ได้รับ', value: `\`\`\`${account}\`\`\``, inline: true })
                        .setFooter({ text: `ORDER: #${totalSold}︲${detail.title}`, iconURL: `${detail.thumbnail}` })
                        .setThumbnail(`${detail.thumbnail}`);

                    await interaction.user.send({ embeds: [dmEmbed] });
                    
                    console.log(`[${thaiTime}] [BUY] 🎬 ผู้ใช้: ${interaction.user.tag} (${interaction.user.id}) | 📦 ซื้อสินค้า: ${detail.title} | 💰 ราคา: ${product.price.toFixed(2)} บาท`);
                } catch (error) {
                }

                await interaction.deferReply({ ephemeral: true });
                const successEmbed = new EmbedBuilder()
                    .setTitle('``✅`` ซื้อสินค้าสำเร็จ!')
                    .setDescription(
                        `\`\`🏠\`\` **สินค้า:** **\`\`${detail.title}\`\`**\n` +
                        `\`\`💰\`\` **ราคา:** **\`\`${product.price.toFixed(2)} บาท\`\`**\n` +
                        `\`\`📦\`\` **รหัสสินค้า:** **\`\`${totalSold}\`\`**\n` +
                        `\`\`✔️\`\` **สถานะ:** **\`\`คำสั่งซื้อสำเร็จเรียบร้อย\`\`**\n` +
                        `\`\`🎬\`\` **สินค้าถูกส่งไปที่ DM ของคุณแล้ว**`
                    )
                    .setThumbnail(`${detail.thumbnail}`)
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&')
                    .setColor('#00FF00');

                await interaction.editReply({ embeds: [successEmbed], components: [], ephemeral: true });

                const logChannel = client.channels.cache.get(BUY_LOG_CHANNEL_ID);
                await Logger.sendAppPremiumBuyLog(
                    interaction.user,
                    product.price,
                    detail.title,
                    product.category,
                    totalSold,
                    detail,
                    logChannel,
                    thaiTime
                );
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'topup_truemoney_modal') {
                const link = interaction.fields.getTextInputValue('gift_link');

                await interaction.deferReply({ ephemeral: true });
                const result = await topupSystem.processTopup(interaction.user.id, link);

                if (result.success) {
                    const embed = new EmbedBuilder()
                        .setTitle('``✅`` เติมเงินสำเร็จ!')
                        .setDescription(
                            `\`\`💰\`\` **จำนวนเงิน:** **\`\`${result.amount} บาท\`\`**\n` +
                            `\`\`💳\`\` **ยอดคงเหลือ:** **\`\`${result.userPoints.toFixed(2)} บาท\`\`**\n` +
                            `\`\`🧧\`\` **ชำระโดย:** \`${result.ownerName}\``
                        )
                        .setColor('#00FF00')
                        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

                    await interaction.editReply({ embeds: [embed] });
                    console.log(`[TOPUP] 💰 ผู้ใช้: ${interaction.user.tag} (${interaction.user.id}) | 🧧 เติมเงินจำนวน: ${result.amount} บาท | 💳 ชำระโดย: ${result.ownerName}`);

                    const logChannel = client.channels.cache.get(TOPUP_LOG_CHANNEL_ID);
                    await Logger.sendTopupLog(
                        interaction.user,
                        result.amount,
                        result.userPoints,
                        link,
                        logChannel,
                        result.ownerName
                    );
                } else {
                    const error = new EmbedBuilder()
            .setTitle('``❌`` เกิดข้อผิดพลาดเติมเงิน')
            .setColor(0xFF0000)
            .setDescription(`\`\`\`${result.message}\`\`\``)
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');
                    await interaction.editReply({ embeds: [error] });
                }
            }
        }

    } catch (error) {
        console.error('[ERROR] ⚠️ ERROR ครั้งที่ 1:', error)
        if (interaction.deferred || interaction.replied) {
            const error = new EmbedBuilder()
            .setTitle('``❌`` เกิดข้อผิดพลาด')
            .setColor(0xFF0000)
            .setDescription('```❌ เกิดข้อผิดพลาดบางอย่าง กรุณาลองใหม่อีกครั้ง 1```')
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');
            await interaction.editReply({ embeds: [error] }).catch(() => {});
        } else {
            const error = new EmbedBuilder()
            .setTitle('``❌`` เกิดข้อผิดพลาด')
            .setColor(0xFF0000)
            .setDescription('```❌ เกิดข้อผิดพลาดบางอย่าง กรุณาลองใหม่อีกครั้ง 2```')
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');
            await interaction.reply({ embeds: [error], ephemeral: true }).catch(() => {});
            console.error('[ERROR] ⚠️ ERROR ครั้งที่ 2:', error)
        }
    }
});

client.login(TOKEN);
