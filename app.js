/*
* @Author: dmyang
* @Date:   2016-01-06 11:41:18
* @Last Modified by:   dm
* @Last Modified time: 2016-01-09 02:42:20
*/

'use strict';

const http = require('http')
const https = require('https')
const fs = require('fs')
const url = require('url')
const qs = require('querystring')
const util = require('util')

const open = require('open')
const _ = require('lodash')
const c = require('colors')

const DEBUD = !!process.argv[2] || 1
const QR_IMAGE_PATH = './qr.jpg'
const DEVICE_ID = 'e000000000000000'

let _tip = 0
let _ticket = ''
let _skey = ''
let _baseRequest = {}
let _profile

function get(u, params, preProcess) {
    let arg = arguments

    params = typeof arg[1] == 'object' ? arg[1] : {}
    preProcess = typeof arg[1] == 'function' ?
        arg[1] : (typeof arg[2] == 'function' ? arg[2] : ((r) => {return r}))

    params._t = Date.now()

    u += '?' + qs.stringify(params, null, null, {encodeURIComponent: (v) => {return v}})

    if(DEBUD) console.log(c.cyan('GET') + ` ${u}`)

    return new Promise((resolve, reject) => {
        (/^https/.test(u) ? https : http).get(u, (res) => {
            res.on('error', (err) => {
                console.error(`response ${u} error`, err)
                reject(err)
            })

            let chunks = []

            res.on('data', (chunk) => {
                chunks.push(chunk)
            })

            res.on('end', () => {
                resolve(preProcess(Buffer.concat(chunks)))
            })
        }).on('error', (err) => {
            console.log(`request ${u} error`, err)
            reject(err)
        })
    })
}

function post(u, data, headers) {
    let parsed = url.parse(u, null, null, {decodeURIComponent: decodeURIComponent})

    // let postData = qs.stringify(data) // qs.stringify只能序列化嵌套一层的对象
    let postData = JSON.stringify(data)

    let options = {
        method: 'POST',
        // port: 80,
        hostname: parsed.hostname,
        path: parsed.path + '&_t=' + Date.now(),
        headers: _.assign(headers || {}, {
            'Content-Length': postData.length
        })
    }

    if(DEBUD) console.log(c.cyan('POST') + ` ${u} data ${postData}`)

    return new Promise((resolve, reject) => {
        let req = (/^https/.test(options.protocol) ? https : http).request(options, (res) => {
            let chunks = []

            res.on('data', (chunk) => {
                chunks.push(chunk)
            })

            res.on('end', () => {
                resolve(Buffer.concat(chunks))
            })

            res.on('error', (err) => {
                console.error(`response ${u} data ${postData} error`, err)
                reject(err)
            })
        })

        req.on('error', (err) => {
            console.error(`request ${u} data ${postData} error`, err)
            reject(err)
        })

        req.write(postData)
        req.end()
    })
}

function getUUID() {
    let u = 'https://login.weixin.qq.com/jslogin'

    let params = {
        appid: 'wx782c26e4c19acffb',
        fun: 'new',
        lang: 'zh_CN'
    }

    return get(u, params, (data) => {
        let str = data.toString()
        let m1 = str.match(/window\.QRLogin\.code\s*=\s*(\d+)/)
        let m2 = m1 && m1[1] == 200 ? str.match(/window\.QRLogin\.uuid\s*=\s*\"([^\"]+)\"/) : null
        let uuid = m2 ? m2[1] : ''
        return uuid
    })
}

function genQR(uuid) {
    let u = 'https://login.weixin.qq.com/qrcode/' + uuid

    let params = {
        t: 'webwx'
    }

    return new Promise((resolve, reject) => {
        get(u, params).then((data) => {
            _tip = 1
            fs.writeFile(QR_IMAGE_PATH, data, (err) => {
                if(err) reject(err)
                else resolve(QR_IMAGE_PATH)
            })
        }, (err) => {
            _tip = 1
            reject(err)
        })
    })
}

function scanLogin(uuid) {
    let u = 'https://login.weixin.qq.com/cgi-bin/mmwebwx-bin/login'

    let params = {
        tip: _tip,
        uuid: uuid
    }

    get(u, params).then((data) => {
        let str = data.toString()
        let m1 = str.match(/window\.code\s*=\s*(\d+)/)
        let code = m1 ? m1[1] : -1

        if(code == 200) {
            let m2 = str.match(/redirect_uri\s*=\s*\"([^\"]+)\"/)
            let ru = m2 ? m2[1] + '&fun=new' : ''

            process.emit('login:success', ru)
        } else {
            if(code == 201) _tip = 0

            process.emit('login:fail', uuid, code)
        }
    }, (err) => {
        process.emit('login:fail', uuid)
    })
}

function getBaseInfo(u) {
    return new Promise((resolve, reject) => {
        get(u).then((data) => {
            /*<error>
                <ret>0</ret>
                <message>OK</message>
                <skey>@crypt_4abeeb62_ae3d6c1eace7ec3eca031139f23c7825</skey>
                <wxsid>zYvKYqp/EgvLzcN9</wxsid>
                <wxuin>1057072320</wxuin>
                <pass_ticket>%2FrsJhHkHE4s5J3pmczxs2b2Db1TMG5wJz1KjOuM ns8wcjBrozYHD3STSwFgFurwO
                </pass_ticket>
                <isgrayscale>1</isgrayscale>
            </error>*/
            let str = data.toString()
            let m1 = str.match(/<skey>([^<]+)<\/skey>/)
            let m2 = str.match(/<wxsid>([^<]+)<\/wxsid>/)
            let m3 = str.match(/<wxuin>([^<]+)<\/wxuin>/)
            let m4 = str.match(/<pass_ticket>([^<]+)<\/pass_ticket>/)
            let skey = m1 ? m1[1] : ''
            let wxsid = m2 ? m2[1] : ''
            let wxuin = m3 ? m3[1] : ''
            let passTicket = m4 ? m4[1] : ''

            _ticket = passTicket
            _skey = skey
            _baseRequest = {
                Uin: parseInt(wxuin),
                Sid: wxsid,
                Skey: skey,
                DeviceID: DEVICE_ID
            }

            // resolve() 只能传一个参数？
            resolve({skey: skey, wxsid: wxsid, wxuin: wxuin, passTicket: passTicket})
        }, reject)
    })
}

// initwx
function getProfile(baseUrl) {
    let u = baseUrl + '/webwxinit'

    let params = {
        pass_ticket: _ticket,
        skey: _skey
    }

    let data = {
        BaseRequest: _baseRequest
    }

    u += '?' + qs.stringify(params, null, null, {encodeURIComponent: (v) => {return v}})

    return new Promise((resolve, reject) => {
        post(u, data, {'Content-Type': 'application/json;'})
            .then((data) => {
                data = JSON.parse(data.toString())

                let ret = data.BaseResponse.Ret

                // 个人信息
                _profile = data.User

                if(ret == 0) resolve(_profile)
                else reject(Error(DEBUD ? data.BaseResponse.ErrMsg : '初始化微信失败'))
            }, reject)
    })
}

function getContact(baseUrl) {
    let u = baseUrl + '/webwxgetcontact'

    let params = {
        pass_ticket: _ticket,
        skey: _skey
    }

    let q = qs.stringify(params, null, null, {encodeURIComponent: (v) => {return v}})

    return new Promise((resolve, reject) => {
        let req = https.request({
            host: 'wx2.qq.com',
            hostname: 'wx2.qq.com',
            path: '/cgi-bin/mmwebwx-bin/webwxgetcontact?' + q,
            method: 'GET',
        }, (res) => {
            let chunks = []

            res.on('data', (chunk) => {
                chunks.push(chunk)
            })

            res.on('end', () => {
                resolve(Buffer.concat(chunks).toString())
            })

            res.on('error', (err) => {
                console.error(`response ${u} data ${postData} error`, err)
                reject(err)
            })
        })

        req.on('error', reject)

        req.end()

        return;

        get(u, params).then((data) => {
            data = JSON.parse(data.toString())

            let ret = data.BaseResponse.Ret
            let errMsg = data.BaseResponse.ErrMsg

            if(ret == 0) resolve(data)
            else reject(DEBUD && errMsg ? errMsg: '获取联系人列表失败')
        }, reject)
    })
}

process.on('login:success', (redirectUri) => {
    let baseUrl = redirectUri.slice(0, redirectUri.lastIndexOf('/'))

    // @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise
    // // Executes the method call but an alternative way (1) to handle Promise Reject case
    // $http(mdnAPI)
    //   .get(payload)
    //   .then(callback.success, callback.error);

    // // Executes the method call but an alternative way (2) to handle Promise Reject case
    // $http(mdnAPI)
    //   .get(payload)
    //   .then(callback.success)
    //   .then(undefined, callback.error);
    getBaseInfo(redirectUri)
        .then((info) => {
            return Promise.all([getProfile(baseUrl), getContact(baseUrl)])
        })
        .then((x) => {
            console.log('next =>', x)
        }, (err) => {
            console.error('next err =>', err)
        })

    fs.unlinkSync(QR_IMAGE_PATH)
})

process.on('login:fail', (uuid, code) => {
    console.error(code == 201 ? '成功扫描，请在手机上点击确认登陆' : '登陆失败，即将重试...')

    setTimeout(() => {
        scanLogin(uuid)
    }, 500)
})

getUUID().then((uuid) => {
    console.log('uuid', uuid)
    genQR(uuid).then(open, console.error)
    scanLogin(uuid)
}, console.error)
