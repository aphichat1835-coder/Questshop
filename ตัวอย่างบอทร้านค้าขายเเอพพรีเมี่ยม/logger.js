const { EmbedBuilder } = require('discord.js');

const GREEN = '#00FF00';
const RED = '#FF0000';
const BLUE = '#0099FF';

class Logger {
    static async sendTopupLog(user, amount, balance, link, logChannel, ownerName = 'ไม่ทราบ') {
        if (!logChannel) return;

        const embed = new EmbedBuilder()
            .setDescription(
                '## ``💰`` แจ้งเติมเงินสำเร็จ\n' +
                `\`\`👤\`\` **ผู้ใช้:** **${user}**\n` +
                `\`\`💰\`\` **เติมเงินจำนวน:** **\`\`${amount} บาท\`\`**\n` +
                `\`\`💳\`\` **ยอดเงินคงเหลือ:** **\`\`${balance.toFixed(2)} บาท\`\`**\n` +
                `\`\`🧧\`\` **ชำระโดย:** \`${ownerName}\`\n` +
                `\`\`🏛️\`\` **ชำระผ่าน:** \`\`**ซองอั่งเปาวอเลท**\`\`\n` +
                `\`\`🔗\`\` **ลิงก์: [คลิกที่นี่](${link})**`
            )
            .setColor(GREEN)
            .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&')
            .setThumbnail(user.displayAvatarURL({ dynamic: true }));

        await logChannel.send({ embeds: [embed] });
    }


    static async sendAppPremiumBuyLog(user, price, productName, category, orderNumber, detail, logChannel, thaiTime) {
        if (!logChannel) return;

        const embed = new EmbedBuilder()
            .setDescription(
            '## ``🔔`` คำสั่งซื้อแอพพรีเมี่ยม\n' +
            `\`\`👤\`\` **ผู้ใช้:** **${user}**\n` +
            `\`\`💰\`\` **ราคาสินค้า:** **\`\`${price.toFixed(2)} บาท\`\`**\n` +
            `\`\`📦\`\` **ประเภทรายการ:** **\`\`${category.toUpperCase()}\`\`**\n\n` +
            `\`\`💬\`\` **รหัสสินค้า:** **\`\`${orderNumber}\`\`**\n` +
            `\`\`🏠\`\` **ชื่อสินค้า:** **\`\`${productName.toUpperCase()}\`\`**\n` +
            `\`\`📆\`\` **วันที่︲เวลา:** **\`\`${thaiTime}\`\`**`
            )
            .setColor(`${detail.color}`)
            .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&')
            .setThumbnail(`${detail.thumbnail}`)
            .setFooter({ text: `ORDER: #${orderNumber}︲${productName}`, iconURL: `${detail.thumbnail}` });

        await logChannel.send({ embeds: [embed] });
    }

    
    static async sendAdminManageLog(adminId, userObject, amount, balance, action, logChannel) {
        if (!logChannel) return;

        const actionText = amount > 0 ? 'เพิ่ม' : 'ลด';
        const color = amount > 0 ? GREEN : RED;
        const amountText = amount > 0 ? `+${amount}` : amount;

        const embed = new EmbedBuilder()
            .setDescription(
                '## ``🏛️`` แอดมินจัดการยอดเงิน\n' +
                `\`\`👑\`\` **แอดมิน:** <@${adminId}>\n` +
                `\`\`👤\`\` **ผู้ใช้:** **${userObject}**\n` +
                `\`\`💰\`\` **จำนวน:** **\`\`${amountText} บาท\`\`**\n` +
                `\`\`💳\`\` **ยอดคงเหลือ:** **\`\`${balance.toFixed(2)} บาท\`\`**\n` +
                `\`\`📝\`\` **ได้ทำการ:** **\`\`${actionText}ยอดเงินสำเร็จ\`\`**`
                )
            .setColor(color)
            .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&')
            .setThumbnail(userObject.displayAvatarURL({ dynamic: true }));

        await logChannel.send({ embeds: [embed] });
    }

    static async sendAddStockLog(productName, price, oldStock, newStock, addedAmount, detail, logChannel) {
        if (!logChannel) return;

        const embed = new EmbedBuilder()
            .setDescription(
                '## ``📦`` แจ้งเติมสต๊อกสินค้า\n' +
                `\`\`🏠\`\` **ชื่อสินค้า:** **\`\`${productName}\`\`**\n` +
                `\`\`💰\`\` **ราคา:** **\`\`${price.toFixed(2)} บาท\`\`**\n` +
                `\`\`📥\`\` **เพิ่มสต๊อก:** **\`\`${addedAmount} ชิ้น\`\`**\n` +
                `\`\`🔻\`\` **จาก:** **\`\`${oldStock} ชิ้น\`\`**\n` +
                `\`\`🔺\`\` **เป็น:** **\`\`${newStock} ชิ้น\`\`**`
            )
            .setColor(detail.color)
            .setImage('https://cdn.discordapp.com/attachments/1373550875435470869/1425151020786516068/animated-line-image-0379.gif?ex=68e68ad1&is=68e53951&hm=ed1b9b92dc843c844f8c09e71bb8921355678513012342c17b5b4de046972465&')
            .setThumbnail(detail.thumbnail)
            .setFooter({ text: `STOCK: ${productName}`, iconURL: detail.thumbnail });

        await logChannel.send({ embeds: [embed] });
    }
}

module.exports = Logger;
