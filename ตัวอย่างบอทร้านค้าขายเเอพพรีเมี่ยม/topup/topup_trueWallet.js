const cloudscraper = require('cloudscraper');
const fs = require('fs').promises;
const path = require('path');

class TopupSystem {
    constructor(config = {}) {
        this.phoneNumber = config.phoneNumber || '';
        this.baseDatabasePath = config.databasePath || './data';
        this.timeout = config.timeout || 30000;
        this.maxRetries = config.maxRetries || 3;
    }

    getUserDataPath(userId) {
        return path.join(this.baseDatabasePath, `userMoney_${userId}.json`);
    }

    async loadUserData(userId) {
        const userDataPath = this.getUserDataPath(userId);
        try {
            await fs.mkdir(this.baseDatabasePath, { recursive: true });
            const data = await fs.readFile(userDataPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { point: 0, pointall: 0 };
            }
            console.log(`[LOG] ❌ Error loading data for user ${userId}: ${error.message}`);
            throw error;
        }
    }

    async saveUserData(userId, userData) {
        const userDataPath = this.getUserDataPath(userId);
        try {
            await fs.mkdir(this.baseDatabasePath, { recursive: true });
            await fs.writeFile(userDataPath, JSON.stringify(userData, null, 4), 'utf8');
        } catch (error) {
            console.log(`[LOG] ❌ Error saving data for user ${userId}: ${error.message}`);
            throw error;
        }
    }

    validateGiftLink(link) {
        if (!link || typeof link !== 'string') {
            return false;
        }
        const cleanLink = link.trim().replace(/\s/g, '');
        const regex = /^https:\/\/gift\.truemoney\.com\/campaign(\/)?\?v=[a-zA-Z0-9]+$/;
        return regex.test(cleanLink);
    }

    extractVoucherCode(link) {
        try {
            const url = new URL(link);
            return url.searchParams.get('v');
        } catch (error) {
            return null;
        }
    }

    async redeemVoucher(giftLink) {
        try {
            if (!this.validateGiftLink(giftLink)) {
                return {
                    success: false,
                    error: 'INVALID_LINK_FORMAT',
                    message: 'รูปแบบลิงค์อั่งเปาไม่ถูกต้อง กรุณาตรวจสอบลิงค์อีกครั้ง'
                };
            }

            const voucherCode = this.extractVoucherCode(giftLink);
            if (!voucherCode) {
                return {
                    success: false,
                    error: 'INVALID_VOUCHER_CODE',
                    message: 'ไม่สามารถดึงรหัสซองได้'
                };
            }

            const requestData = {
                mobile: this.phoneNumber,
                voucher_hash: voucherCode
            };

            await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));

            const response = await cloudscraper.post(
                `https://gift.truemoney.com/campaign/vouchers/${voucherCode}/redeem`,
                {
                    json: requestData,
                    timeout: this.timeout,
                    headers: {
                        'Referer': `https://gift.truemoney.com/campaign/?v=${voucherCode}`,
                        'Origin': 'https://gift.truemoney.com'
                    }
                }
            );

            const redeemData = response;

            if (redeemData && redeemData.status && redeemData.status.code === 'SUCCESS') {
                const amount = parseFloat(redeemData.data.my_ticket.amount_baht);
                const ownerName = redeemData.data.owner_profile.full_name;

                console.log(`[LOG] ✅ รับซองอั่งเปาสำเร็จ: ${amount} บาท จาก ${ownerName}`);

                return {
                    success: true,
                    amount: amount,
                    ownerName: ownerName,
                    voucherCode: voucherCode,
                    data: redeemData
                };
            } else if (redeemData && redeemData.status && redeemData.status.code === 'VOUCHER_OUT_OF_STOCK') {
                return {
                    success: false,
                    error: 'VOUCHER_OUT_OF_STOCK',
                    message: 'ซองอั่งเปานี้ถูกใช้ไปแล้ว'
                };
            } else if (redeemData && redeemData.status && redeemData.status.code === 'VOUCHER_EXPIRED') {
                return {
                    success: false,
                    error: 'VOUCHER_EXPIRED',
                    message: 'ซองอั่งเปานี้หมดอายุแล้ว'
                };
            } else if (redeemData && redeemData.status && redeemData.status.code === 'RATE_LIMIT') {
                return {
                    success: false,
                    error: 'RATE_LIMIT',
                    message: 'ระบบยุ่ง กรุณาลองใหม่อีกครั้งในอีกสักครู่'
                };
            } else if (redeemData && redeemData.status && redeemData.status.code === 'CANNOT_GET_OWN_VOUCHER') {
                return {
                    success: false,
                    error: 'CANNOT_GET_OWN_VOUCHER',
                    message: 'ไม่สามารถรับซองของตัวเองได้'
                };
            } else {
                return {
                    success: false,
                    error: 'API_ERROR',
                    message: redeemData?.status?.message || 'เกิดข้อผิดพลาดไม่ทราบสาเหตุ'
                };
            }

        } catch (error) {
            console.log(`[LOG] ❌ เติมเงินไม่สำเร็จ: ${error.message}`);

            if (error.code === 'ENOTFOUND') {
                return {
                    success: false,
                    error: 'NETWORK_ERROR',
                    message: 'ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ TrueMoney ได้'
                };
            } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
                return {
                    success: false,
                    error: 'TIMEOUT_ERROR',
                    message: 'หมดเวลาการเชื่อมต่อ กรุณาลองใหม่อีกครั้ง'
                };
            } else if (error.response && error.response.statusCode === 400) {
                try {
                    const errorData = typeof error.response.body === 'string'
                        ? JSON.parse(error.response.body)
                        : error.response.body;

                    if (errorData && errorData.status && errorData.status.code === 'VOUCHER_OUT_OF_STOCK') {
                        return {
                            success: false,
                            error: 'VOUCHER_OUT_OF_STOCK',
                            message: 'ซองอั่งเปานี้ถูกใช้ไปแล้ว'
                        };
                    } else if (errorData && errorData.status && errorData.status.code === 'VOUCHER_EXPIRED') {
                        return {
                            success: false,
                            error: 'VOUCHER_EXPIRED',
                            message: 'ซองอั่งเปานี้หมดอายุแล้ว'
                        };
                    } else if (errorData && errorData.status && errorData.status.code === 'VOUCHER_NOT_FOUND') {
                        return {
                            success: false,
                            error: 'VOUCHER_NOT_FOUND',
                            message: 'ไม่พบซองอั่งเปานี้'
                        };
                    } else if (errorData && errorData.status && errorData.status.code === 'CANNOT_GET_OWN_VOUCHER') {
                        return {
                            success: false,
                            error: 'CANNOT_GET_OWN_VOUCHER',
                            message: 'ไม่สามารถรับซองของตัวเองได้'
                        };
                    }
                } catch (parseError) {

                }

                return {
                    success: false,
                    error: 'HTTP_ERROR',
                    message: `เกิดข้อผิดพลาด HTTP: ${error.response.statusCode || 'ไม่ทราบ'}`
                };
            } else {
                return {
                    success: false,
                    error: 'HTTP_ERROR',
                    message: `เกิดข้อผิดพลาด HTTP: ${error.response?.statusCode || 'ไม่ทราบ'}`
                };
            }
        }
    }

    async loadAccountData() {
        console.log("[LOG] ⚠️ loadAccountData is deprecated. Use loadUserData instead.");
        return {};
    }

    async saveAccountData(accountData) {
        console.log("[LOG] ⚠️ saveAccountData is deprecated. Use saveUserData instead.");
    }

    async addPointsToUser(userId, amount) {
        try {
            const userData = await this.loadUserData(userId);
            userData.point += amount;
            if (amount > 0) {
                userData.pointall += amount;
            }
            await this.saveUserData(userId, userData);
            return userData;
        } catch (error) {
            console.log(`[LOG] ❌ เกิดข้อผิดพลาดในการเพิ่มเงิน: ${error.message}`);
            throw error;
        }
    }

    async getUserData(userId) {
        try {
            return await this.loadUserData(userId);
        } catch (error) {
            console.log(`[LOG] ❌ เกิดข้อผิดพลาดในการดึงข้อมูลผู้ใช้: ${error.message}`);
            return { point: 0, pointall: 0 };
        }
    }

    async processTopup(userId, giftLink) {
        try {
            const redeemResult = await this.redeemVoucher(giftLink);

            if (!redeemResult.success) {
                console.log(`[LOG] ❌ เติมเงินไม่สำเร็จ: ${redeemResult.message}`);
                return redeemResult;
            }

            const userData = await this.addPointsToUser(userId, redeemResult.amount);

            return {
                success: true,
                amount: redeemResult.amount,
                ownerName: redeemResult.ownerName,
                voucherCode: redeemResult.voucherCode,
                userPoints: userData.point,
                totalPoints: userData.pointall,
                giftLink: giftLink
            };

        } catch (error) {
            console.log(`[LOG] ❌ เกิดข้อผิดพลาดในการทำธุรกรรม: ${error.message}`);
            return {
                success: false,
                error: 'TRANSACTION_ERROR',
                message: `เกิดข้อผิดพลาดในการทำธุรกรรม: ${error.message}`
            };
        }
    }
}

module.exports = TopupSystem;