const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const { productDetails } = require('./product/product_detail');

const adminCommands = [
    new SlashCommandBuilder()
        .setName('ติดตั้งเมนูขายแอพพรีเมี่ยม')
        .setDescription('[ 🎬 ติดตั้งเมนูขายแอพพรีเมียม ]')
        .addChannelOption(option =>
            option.setName('ช่อง')
                .setDescription('เลือกช่องที่ต้องการส่งเมนู')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText)
        ),

    new SlashCommandBuilder()
        .setName('จัดการยอดเงิน')
        .setDescription('[ 💳 เพิ่ม/ลด ยอดเงินของผู้ใช้งาน ]')
        .addStringOption(option =>
            option.setName('การกระทำ')
                .setDescription('เลือกการกระทำที่ต้องการ')
                .setRequired(true)
                .addChoices(
                    { name: '[+] เพิ่มเงิน', value: 'add' },
                    { name: '[-] ลดเงิน', value: 'remove' }
                )
        )
        .addUserOption(option =>
            option.setName('ผู้ใช้')
                .setDescription('เลือกผู้ใช้ที่ต้องการจัดการ')
                .setRequired(true)
        )
        .addNumberOption(option =>
            option.setName('จำนวน')
                .setDescription('จำนวนเงิน (ขั้นต่ำ 0.1 บาท)')
                .setRequired(true)
                .setMinValue(0.1)
        ),
    
        new SlashCommandBuilder()
        .setName('เช็คยอดเงินผู้ใช้')
        .setDescription('[ 🏛️ เช็คยอดเงินของผู้ใช้งาน ]')
        .addUserOption(option =>
            option.setName('ผู้ใช้')
                .setDescription('เลือกผู้ใช้ที่ต้องการเช็ค')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('อัพโหลดสต๊อกสินค้า')
        .setDescription('[ 📦 อัพโหลดสต๊อกสินค้าจากไฟล์ TXT ]')
        .addStringOption(option =>
            option.setName('เลือกแอพ')
                .setDescription('เลือกแอพที่ต้องการอัพโหลดสต๊อก')
                .setRequired(true)
                .addChoices(
                    { name: 'YouTube Premium /30วัน (เมลตัวเอง)', value: 'youtube_premium_myemail_30d' },
                    { name: 'YouTube Premium /30วัน (เมลร้าน)', value: 'youtube_premium_shopemail_30d' },
                    { name: 'Netflix 4K /1วัน (จอส่วนตัว)', value: 'netflix_4k_private_1d' },
                    { name: 'Netflix 4K /1วัน (TV) (จอส่วนตัว)', value: 'netflix_4k_tv_private_1d' },
                    { name: 'Netflix 4K /7วัน (TV) (จอส่วนตัว)', value: 'netflix_4k_tv_private_7d' },
                    { name: 'Netflix 4K /30วัน (จอส่วนตัว)', value: 'netflix_4k_private_30d' },
                    { name: 'Netflix 4K /30วัน (TV) (จอส่วนตัว)', value: 'netflix_4k_tv_private_30d' },
                    { name: 'iQIYI Gold /30วัน', value: 'iqiyi_gold_30d' },
                    { name: 'Bilibili /30วัน', value: 'bilibili_30d' },
                    { name: 'VIU Premium /7วัน', value: 'viu_premium_7d' },
                    { name: 'VIU Premium /30วัน', value: 'viu_premium_30d' },
                    { name: 'WeTV VIP /30วัน', value: 'wetv_vip_30d' },
                    { name: 'Disney+ /30วัน (จอส่วนตัว) (ทุกอุปกรณ์)', value: 'disneyplus_private_alldevice_30d' },
                    { name: 'MONOMAX /30วัน (จอส่วนตัว)', value: 'monomax_private_30d' },
                    { name: 'MONOMAX /30วัน (จอส่วนตัว + พรีเมียร์ลีก)', value: 'monomax_private_premierleague_30d' },
                    { name: 'HBO Max /30วัน (HD) (จอส่วนตัว)', value: 'hbomax_hd_private_30d' },
                    { name: 'HBO Max /30วัน (4K) (จอส่วนตัว)', value: 'hbomax_4k_private_30d' },
                    { name: 'CH3 Plus /30วัน (จอแชร์)', value: 'ch3plus_share_30d' },
                    { name: 'CH3 Plus /30วัน (จอส่วนตัว)', value: 'ch3plus_private_30d' },
                    { name: 'Amazon Prime Video /30วัน', value: 'amazonprimevideo_30d' },
                    { name: 'TrueID+ /30วัน', value: 'trueidplus_30d' },
                    { name: 'YOUKU VIP /30วัน', value: 'youku_vip_30d' },
                    { name: 'oneD /30วัน', value: 'oned_30d' },
                    { name: 'Crunchyroll Premium /30วัน', value: 'crunchyroll_premium_30d' }
                )
        )
        .addAttachmentOption(option =>
            option.setName('ไฟล์')
                .setDescription('อัพโหลดไฟล์ TXT (แต่ละบรรทัด: email:password)')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('ตั้งราคาสินค้า')
        .setDescription('[ 💰 ตั้งราคาของสินค้า ]')
        .addStringOption(option =>
            option.setName('เลือกแอพ')
                .setDescription('เลือกแอพที่ต้องการตั้งราคา')
                .setRequired(true)
                .addChoices(
                    { name: 'YouTube Premium /30วัน (เมลตัวเอง)', value: 'youtube_premium_myemail_30d' },
                    { name: 'YouTube Premium /30วัน (เมลร้าน)', value: 'youtube_premium_shopemail_30d' },
                    { name: 'Netflix 4K /1วัน (จอส่วนตัว)', value: 'netflix_4k_private_1d' },
                    { name: 'Netflix 4K /1วัน (TV) (จอส่วนตัว)', value: 'netflix_4k_tv_private_1d' },
                    { name: 'Netflix 4K /7วัน (TV) (จอส่วนตัว)', value: 'netflix_4k_tv_private_7d' },
                    { name: 'Netflix 4K /30วัน (จอส่วนตัว)', value: 'netflix_4k_private_30d' },
                    { name: 'Netflix 4K /30วัน (TV) (จอส่วนตัว)', value: 'netflix_4k_tv_private_30d' },
                    { name: 'iQIYI Gold /30วัน', value: 'iqiyi_gold_30d' },
                    { name: 'Bilibili /30วัน', value: 'bilibili_30d' },
                    { name: 'VIU Premium /7วัน', value: 'viu_premium_7d' },
                    { name: 'VIU Premium /30วัน', value: 'viu_premium_30d' },
                    { name: 'WeTV VIP /30วัน', value: 'wetv_vip_30d' },
                    { name: 'Disney+ /30วัน (จอส่วนตัว) (ทุกอุปกรณ์)', value: 'disneyplus_private_alldevice_30d' },
                    { name: 'MONOMAX /30วัน (จอส่วนตัว)', value: 'monomax_private_30d' },
                    { name: 'MONOMAX /30วัน (จอส่วนตัว + พรีเมียร์ลีก)', value: 'monomax_private_premierleague_30d' },
                    { name: 'HBO Max /30วัน (HD) (จอส่วนตัว)', value: 'hbomax_hd_private_30d' },
                    { name: 'HBO Max /30วัน (4K) (จอส่วนตัว)', value: 'hbomax_4k_private_30d' },
                    { name: 'CH3 Plus /30วัน (จอแชร์)', value: 'ch3plus_share_30d' },
                    { name: 'CH3 Plus /30วัน (จอส่วนตัว)', value: 'ch3plus_private_30d' },
                    { name: 'Amazon Prime Video /30วัน', value: 'amazonprimevideo_30d' },
                    { name: 'TrueID+ /30วัน', value: 'trueidplus_30d' },
                    { name: 'YOUKU VIP /30วัน', value: 'youku_vip_30d' },
                    { name: 'oneD /30วัน', value: 'oned_30d' },
                    { name: 'Crunchyroll Premium /30วัน', value: 'crunchyroll_premium_30d' }
                )
        )
        .addNumberOption(option =>
            option.setName('ราคา')
                .setDescription('ราคาสินค้า (ขั้นต่ำ 0.1 บาท)')
                .setRequired(true)
                .setMinValue(0.1)
        ),

    new SlashCommandBuilder()
        .setName('ล้างสต๊อกสินค้าทั้งหมด')
        .setDescription('[ 🗑️ ล้างสต๊อกสินค้า ]')
        .addStringOption(option =>
            option.setName('เลือกแอพ')
                .setDescription('เลือกแอพที่ต้องการล้างสต๊อก (ไม่เลือก = ล้างทั้งหมด)')
                .setRequired(false)
                .addChoices(
                    { name: 'YouTube Premium /30วัน (เมลตัวเอง)', value: 'youtube_premium_myemail_30d' },
                    { name: 'YouTube Premium /30วัน (เมลร้าน)', value: 'youtube_premium_shopemail_30d' },
                    { name: 'Netflix 4K /1วัน (จอส่วนตัว)', value: 'netflix_4k_private_1d' },
                    { name: 'Netflix 4K /1วัน (TV) (จอส่วนตัว)', value: 'netflix_4k_tv_private_1d' },
                    { name: 'Netflix 4K /7วัน (TV) (จอส่วนตัว)', value: 'netflix_4k_tv_private_7d' },
                    { name: 'Netflix 4K /30วัน (จอส่วนตัว)', value: 'netflix_4k_private_30d' },
                    { name: 'Netflix 4K /30วัน (TV) (จอส่วนตัว)', value: 'netflix_4k_tv_private_30d' },
                    { name: 'iQIYI Gold /30วัน', value: 'iqiyi_gold_30d' },
                    { name: 'Bilibili /30วัน', value: 'bilibili_30d' },
                    { name: 'VIU Premium /7วัน', value: 'viu_premium_7d' },
                    { name: 'VIU Premium /30วัน', value: 'viu_premium_30d' },
                    { name: 'WeTV VIP /30วัน', value: 'wetv_vip_30d' },
                    { name: 'Disney+ /30วัน (จอส่วนตัว) (ทุกอุปกรณ์)', value: 'disneyplus_private_alldevice_30d' },
                    { name: 'MONOMAX /30วัน (จอส่วนตัว)', value: 'monomax_private_30d' },
                    { name: 'MONOMAX /30วัน (จอส่วนตัว + พรีเมียร์ลีก)', value: 'monomax_private_premierleague_30d' },
                    { name: 'HBO Max /30วัน (HD) (จอส่วนตัว)', value: 'hbomax_hd_private_30d' },
                    { name: 'HBO Max /30วัน (4K) (จอส่วนตัว)', value: 'hbomax_4k_private_30d' },
                    { name: 'CH3 Plus /30วัน (จอแชร์)', value: 'ch3plus_share_30d' },
                    { name: 'CH3 Plus /30วัน (จอส่วนตัว)', value: 'ch3plus_private_30d' },
                    { name: 'Amazon Prime Video /30วัน', value: 'amazonprimevideo_30d' },
                    { name: 'TrueID+ /30วัน', value: 'trueidplus_30d' },
                    { name: 'YOUKU VIP /30วัน', value: 'youku_vip_30d' },
                    { name: 'oneD /30วัน', value: 'oned_30d' },
                    { name: 'Crunchyroll Premium /30วัน', value: 'crunchyroll_premium_30d' }
                )
        )
];

async function handleAdminCommands(interaction, topupSystem, logChannel, adminLogChannel, addStockLogChannel, ADMIN_IDS) {
    const { EmbedBuilder } = require('discord.js');

    if (!ADMIN_IDS || !ADMIN_IDS.includes(interaction.user.id)) {
        const noPermissionEmbed = new EmbedBuilder()
            .setTitle('``❌`` ไม่มีสิทธิ์')
            .setDescription('```❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้```')
            .setColor('#FF0000')
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

        return interaction.reply({ embeds: [noPermissionEmbed], ephemeral: true });
    }

    const commandName = interaction.commandName;

    if (commandName === 'จัดการยอดเงิน') {
        const action = interaction.options.getString('การกระทำ');
        const user = interaction.options.getUser('ผู้ใช้');
        const amount = interaction.options.getNumber('จำนวน');

        try {
            const finalAmount = action === 'add' ? amount : -amount;
            const userData = await topupSystem.addPointsToUser(user.id, finalAmount);

            const successEmbed = new EmbedBuilder()
                .setTitle(`\`\`✅\`\` ${action === 'add' ? 'เพิ่ม' : 'ลด'}ยอดเงินสำเร็จ`)
                .setDescription(
                    `\`\`👤\`\` **ผู้ใช้:** ${user}\n` +
                    `\`\`💰\`\` **จำนวน:** **\`\`${amount.toFixed(2)} บาท\`\`**\n` +
                    `\`\`💳\`\` **ยอดคงเหลือ:** **\`\`${userData.point.toFixed(2)} บาท\`\`**`
                )
                .setColor(action === 'add' ? '#00FF00' : '#FF0000')
                .setThumbnail(user.displayAvatarURL({ dynamic: true }))
                .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

            await interaction.reply({ 
                embeds: [successEmbed],
                ephemeral: true
            });

            const Logger = require('./logger');
            await Logger.sendAdminManageLog(
                interaction.user.id,
                user,
                finalAmount,
                userData.point,
                action === 'add' ? 'เพิ่ม' : 'ลด',
                adminLogChannel
            );
        } catch (error) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('``❌`` เกิดข้อผิดพลาด')
                .setDescription('```❌ เกิดข้อผิดพลาดในการจัดการยอดเงิน```')
                .setColor('#FF0000')
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            } else {
                await interaction.editReply({ embeds: [errorEmbed] });
            }
        }
    }

    if (commandName === 'อัพโหลดสต๊อกสินค้า') {
        const productKey = interaction.options.getString('เลือกแอพ');
        const attachment = interaction.options.getAttachment('ไฟล์');

        if (!attachment.name.endsWith('.txt')) {
            const { EmbedBuilder } = require('discord.js');
            const fileTypeEmbed = new EmbedBuilder()
                .setTitle('``❌`` ไฟล์ไม่ถูกต้อง')
                .setDescription('```❌ กรุณาอัพโหลดไฟล์ .txt เท่านั้น```')
                .setColor('#FF0000')
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

            return interaction.reply({ embeds: [fileTypeEmbed], ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const response = await fetch(attachment.url);
            const text = await response.text();

            if (!text || text.trim() === '') {
                const { EmbedBuilder } = require('discord.js');
                const emptyFileEmbed = new EmbedBuilder()
                    .setTitle('``❌`` รูปแบบไฟล์ไม่ถูกต้อง')
                    .setDescription('```❌ รูปแบบไฟล์ไม่ถูกต้อง```')
                    .setColor('#FF0000')
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

                return interaction.editReply({ embeds: [emptyFileEmbed] });
            }

            const accounts = text
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line !== '');

            const stockPath = path.join(__dirname, 'product', 'product_stock.json');
            const stockData = JSON.parse(await fs.readFile(stockPath, 'utf8'));

            if (!stockData[productKey]) {
                const { EmbedBuilder } = require('discord.js');
                const notFoundEmbed = new EmbedBuilder()
                    .setTitle('``❌`` ไม่พบสินค้า')
                    .setDescription('```❌ ไม่พบสินค้านี้ในระบบ```')
                    .setColor('#FF0000')
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

                return interaction.editReply({ embeds: [notFoundEmbed] });
            }

            const oldStock = stockData[productKey].stock;
            stockData[productKey].accounts.push(...accounts);
            stockData[productKey].stock = stockData[productKey].accounts.length;
            const newStock = stockData[productKey].stock;

            await fs.writeFile(stockPath, JSON.stringify(stockData, null, 4), 'utf8');

            const detail = productDetails[productKey];
            const { EmbedBuilder } = require('discord.js');

            const productTitle = detail.title;
            const productColor = detail.color;
            const productThumbnail = detail.thumbnail;
            const productDescription = detail.description;
            const productCategory = detail.category;
            const productEmoji = detail.appEmoji;

            const successEmbed = new EmbedBuilder()
                .setTitle(`\`\`✅\`\` อัพโหลดสต๊อกสำเร็จ`)
                .setDescription(
                    `\`\`🎬\`\` **ชื่อสินค้า:** **\`\`${productTitle}\`\`**\n` +
                    `\`\`✔️\`\` **เพิ่มสินค้า:** **\`\`${accounts.length} ชิ้น\`\`**\n` +
                    `\`\`📤\`\` **สต๊อกเดิม:** **\`\`${oldStock} ชิ้น\`\`**\n` +
                    `\`\`📥\`\` **สต๊อกใหม่:** **\`\`${newStock} ชิ้น\`\`**\n` +
                    `\`\`??\`\` **สต๊อกรวม:** **\`\`${stockData[productKey].stock} ชิ้น\`\`**`
                )
                .setColor(productColor)
                .setThumbnail(productThumbnail)
                .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&')
                .setFooter({ text: `STOCK: ${productTitle}`, iconURL: productThumbnail });

            await interaction.editReply({ embeds: [successEmbed] });

            const Logger = require('./logger');
            await Logger.sendAddStockLog(
                productTitle,
                stockData[productKey].price,
                oldStock,
                newStock,
                accounts.length,
                detail,
                addStockLogChannel
            );
        } catch (error) {
            const { EmbedBuilder } = require('discord.js');
            const errorEmbed = new EmbedBuilder()
                .setTitle('``❌`` เกิดข้อผิดพลาด')
                .setDescription(
                    `\`\`\`❌ เกิดข้อผิดพลาดในการอัพโหลดสต๊อก\`\`\``
                )
                .setColor('#FF0000')
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

            await interaction.editReply({ embeds: [errorEmbed] });
        }
    }

    if (commandName === 'ตั้งราคาสินค้า') {
        const productKey = interaction.options.getString('เลือกแอพ');
        const newPrice = interaction.options.getNumber('ราคา');

        try {
            const stockPath = path.join(__dirname, 'product', 'product_stock.json');
            const stockData = JSON.parse(await fs.readFile(stockPath, 'utf8'));

            if (!stockData[productKey]) {
                const { EmbedBuilder } = require('discord.js');
                const notFoundEmbed = new EmbedBuilder()
                    .setTitle('``❌`` ไม่พบสินค้า')
                    .setDescription('```❌ ไม่พบสินค้านี้ในระบบ```')
                    .setColor('#FF0000')
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

                return interaction.reply({ embeds: [notFoundEmbed], ephemeral: true });
            }

            const oldPrice = stockData[productKey].price;
            stockData[productKey].price = newPrice;

            await fs.writeFile(stockPath, JSON.stringify(stockData, null, 4), 'utf8');

            const detail = productDetails[productKey];

            const productTitle = detail.title;
            const productColor = detail.color;
            const productThumbnail = detail.thumbnail;
            const productCategory = detail.category;
            const productEmoji = detail.appEmoji;

            const successEmbed = new EmbedBuilder()
                .setTitle(`\`\`✅\`\` ตั้งราคาสินค้าสำเร็จ`)
                .setDescription(
                    `\`\`🎬\`\` **ชื่อสินค้า:** **\`\`${productTitle}\`\`**\n` +
                    `\`\`💸\`\` **ราคาเดิม:** **\`\`${oldPrice.toFixed(2)} บาท\`\`**\n` +
                    `\`\`💰\`\` **ราคาใหม่:** **\`\`${newPrice.toFixed(2)} บาท\`\`**\n` +
                    `\`\`📦\`\` **สต๊อกคงเหลือ:** **\`\`${stockData[productKey].stock} ชิ้น\`\`**`
                )
                .setColor(productColor)
                .setThumbnail(productThumbnail)
                .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&')
                .setFooter({ text: `STOCK: ${productTitle}`, iconURL: productThumbnail });

            await interaction.reply({ 
                embeds: [successEmbed],
                ephemeral: true
            });
        } catch (error) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('``❌`` เกิดข้อผิดพลาด')
                .setDescription('```❌ เกิดข้อผิดพลาดในการตั้งราคา```')
                .setColor('#FF0000')
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            } else {
                await interaction.editReply({ embeds: [errorEmbed] });
            }
        }
    }

    if (commandName === 'ล้างสต๊อกสินค้าทั้งหมด') {
        const productKey = interaction.options.getString('เลือกแอพ');

        try {
            const stockPath = path.join(__dirname, 'product', 'product_stock.json');
            const stockData = JSON.parse(await fs.readFile(stockPath, 'utf8'));

            let clearedProducts = [];

            if (productKey) {
                if (!stockData[productKey]) {
                    const { EmbedBuilder } = require('discord.js');
                    const notFoundEmbed = new EmbedBuilder()
                        .setTitle('``❌`` ไม่พบสินค้า')
                        .setDescription('```❌ ไม่พบสินค้านี้ในระบบ```')
                        .setColor('#FF0000')
                        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                        .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

                    return interaction.reply({ embeds: [notFoundEmbed], ephemeral: true });
                }

                const oldStock = stockData[productKey].stock;
                stockData[productKey].accounts = [];
                stockData[productKey].stock = 0;

                const detail = productDetails[productKey];
                clearedProducts.push({
                    title: detail.title,
                    oldStock: oldStock,
                    color: detail.color,
                    thumbnail: detail.thumbnail
                });
            } else {
                for (const [key, product] of Object.entries(stockData)) {
                    if (product.stock > 0) {
                        const detail = productDetails[key];
                        clearedProducts.push({
                            title: detail.title,
                            oldStock: product.stock
                        });
                        product.accounts = [];
                        product.stock = 0;
                    }
                }
            }

            await fs.writeFile(stockPath, JSON.stringify(stockData, null, 4), 'utf8');

            const { EmbedBuilder } = require('discord.js');

            if (productKey) {
                const detail = productDetails[productKey];
                const successEmbed = new EmbedBuilder()
                    .setTitle(`\`\`✅\`\` ล้างสต๊อกสินค้าสำเร็จ`)
                    .setDescription(
                        `\`\`🎬\`\` **ชื่อสินค้า:** **\`\`${clearedProducts[0].title}\`\`**\n` +
                        `\`\`🚫\`\` **ล้างสต๊อก:** **\`\`${clearedProducts[0].oldStock} ชิ้น\`\`**\n` +
                        `\`\`📦\`\` **สต๊อกคงเหลือ:** **\`\`0 ชิ้น\`\`**`
                    )
                    .setColor(clearedProducts[0].color)
                    .setThumbnail(clearedProducts[0].thumbnail)
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&')
                    .setFooter({ text: `STOCK: ${clearedProducts[0].title}`, iconURL: clearedProducts[0].thumbnail });

                await interaction.reply({ 
                    embeds: [successEmbed],
                    ephemeral: true
                });
            } else {
                const totalCleared = clearedProducts.reduce((sum, p) => sum + p.oldStock, 0);
                const successEmbed = new EmbedBuilder()
                    .setTitle(`\`\`✅\`\` ล้างสต๊อกทั้งหมดสำเร็จ`)
                    .setDescription(
                        `\`\`🎬\`\` **จำนวนสินค้าที่ล้าง:** **\`\`${clearedProducts.length} รายการ\`\`**\n` +
                        `\`\`🚫\`\` **ล้างสต๊อกทั้งหมด:** **\`\`${totalCleared} ชิ้น\`\`**\n` +
                        `\`\`📦\`\` **สต๊อกคงเหลือ:** **\`\`0 ชิ้น\`\`**`
                    )
                    .setColor('#00FF00')
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

                await interaction.reply({ 
                    embeds: [successEmbed],
                    ephemeral: true
                });
            }
        } catch (error) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('``❌`` เกิดข้อผิดพลาด')
                .setDescription('```❌ เกิดข้อผิดพลาดในการล้างสต๊อก```')
                .setColor('#FF0000')
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            } else {
                await interaction.editReply({ embeds: [errorEmbed] });
            }
        }
    }

    if (commandName === 'เช็คยอดเงินผู้ใช้') {
        const user = interaction.options.getUser('ผู้ใช้');

        try {
            const userData = await topupSystem.getUserData(user.id);

            const checkBalanceEmbed = new EmbedBuilder()
                .setTitle(`\`\`💳\`\` ตรวจสอบยอดเงินผู้ใช้`)
                .setDescription(
                    `\`\`👤\`\` **ผู้ใช้:** ${user}\n` +
                    `\`\`🆔\`\` **ไอดี:** **\`\`${user.id}\`\`**\n` +
                    `\`\`🏛️\`\` **ยอดเงินคงเหลือ:** **\`\`${userData.point.toFixed(2)} บาท\`\`**\n` +
                    `\`\`💰\`\` **ยอดเติมเงินทั้งหมด:** **\`\`${userData.pointall.toFixed(2)} บาท\`\`**`
                )
                .setColor('#00D9FF')
                .setThumbnail(user.displayAvatarURL({ dynamic: true }))
                .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');
            await interaction.reply({ 
                embeds: [checkBalanceEmbed],
                ephemeral: true
            });
        } catch (error) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('``❌`` เกิดข้อผิดพลาด')
                .setDescription('```❌ เกิดข้อผิดพลาดในการเช็คยอดเงิน หรือผู้ใช้ยังไม่เคยมียอดเงิน```')
                .setColor('#FF0000')
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&');

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            } else {
                await interaction.editReply({ embeds: [errorEmbed] });
            }
        }
    }
}

module.exports = { adminCommands, handleAdminCommands };