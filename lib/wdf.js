/*
* @Author: dmyang
* @Date:   2016-01-06 11:41:18
* @Last Modified by:   dmyang
* @Last Modified time: 2016-01-11 14:21:18
*/

'use strict';

// 微信客户端通讯原理
// @see http://qxj.me/note/article/id-44.html

const http = require('http')
const https = require('https')
const fs = require('fs')
const url = require('url')
const qs = require('querystring')
const util = require('util')

const open = require('open')
const _ = require('lodash')
const c = require('colors')
const cookie = require('cookie')

const QR_IMAGE_PATH = './qr.jpg'
const DEVICE_ID = 'e1615250492'
// @see https://github.com/0x5e/wechat-deleted-friends/blob/master/wdf.py#L283
const SPEC_USERS = [
    'newsapp', 'fmessage', 'filehelper', 'weibo', 'qqmail',
    'tmessage', 'qmessage', 'qqsync', 'floatbottle', 'lbsapp',
    'shakeapp', 'medianote', 'qqfriend', 'readerapp', 'blogapp',
    'facebookapp', 'masssendapp', 'meishiapp', 'feedsapp',
    'voip', 'blogappweixin', 'weixin', 'brandsessionholder',
    'weixinreminder', 'wxid_novlwrv3lqwv11', 'gh_22b87fa7cb3c',
    'officialaccounts', 'notification_messages', 'wxitil', 'userexperience_alarm'
]
const MAX_GROUP_NUM = 30 // 每组人数
const SEARCH_INTERVAL = 15 * 1000 // 查询时间间隔

let _debug = false
let _tip = 0
let _ticket = ''
let _skey = ''
let _baseRequest = {}
let _baseUrl = ''
let _cookie = {}
let _roomName = ''
let _deletedList = []

/**
 * HTTP client
 * @param {String} u        url
 * @param {Object} data     [{} | null], if data is not empty, request method will be GET, else POST
 * @param {Object} headers  request headers
 */
let request = (u, data, headers) => {
    let parsed = url.parse(u, null, null, {decodeURIComponent: decodeURIComponent})
    let method = !!data ? 'POST' : 'GET'
    let options = {
        method: method,
        hostname: parsed.hostname,
        path: parsed.path + '&r=' + Date.now()
    }

    if('POST' === method) {
        // data = qs.stringify(data) // qs.stringify只能序列化嵌套一层的对象
        data = JSON.stringify(data)
        headers = _.assign(headers || {}, {'Content-Length': data.length})

        if(_debug) console.log(c.cyan('POST') + ` ${u} data ${data}`)
    } else {
        if(_debug) console.log(c.cyan('GET') + ` ${u}`)
    }

    if(headers) options.headers = headers

    return new Promise((resolve, reject) => {
        let req = (/^https/.test(u) ? https : http).request(options, (res) => {
            let cookies = res.headers['set-cookie'] || []

            // if(_debug) console.log('Cookie'.green + ` ${util.inspect(cookies)}`)

            if(cookies.length) _cookie = _.assign(_cookie, cookie.parse(cookies.join(';')))

            let chunks = []

            res.on('data', (chunk) => {
                chunks.push(chunk)
            })

            res.on('end', () => {
                resolve(Buffer.concat(chunks))
            })

            res.on('error', (err) => {
                console.error(`response ${u} error`, err)
                reject(err)
            })
        })

        req.on('error', (err) => {
            console.error(`request ${u} error`, err)
            reject(err)
        })

        if('POST' === method) req.write(data)
        req.end()
    })
}

let serialize = (u, params) => {
    return u += (~u.indexOf('?') ? '' : '?') + qs.stringify(params, null, null, {encodeURIComponent: (v) => {return v}})
}

let wait = (ms, fn) => {
    return () => {
        if(_debug) console.log(`wait ${ms} ms ...`)

        return new Promise((resolve) => {
            setTimeout(fn || resolve, ms)
        })
    }
}

let printErr = (msg) => {
    if(msg instanceof Error && _debug) console.log(err.stack)
    else console.log(String(msg).red)
}

let getUUID = () => {
    let u = 'https://login.weixin.qq.com/jslogin'

    let params = {
        appid: 'wx782c26e4c19acffb',
        fun: 'new',
        lang: 'zh_CN'
    }

    return request(serialize(u, params)).then((data) => {
        let str = data.toString()
        let m1 = str.match(/window\.QRLogin\.code\s*=\s*(\d+)/)
        let m2 = m1 && m1[1] == 200 ? str.match(/window\.QRLogin\.uuid\s*=\s*\"([^\"]+)\"/) : null
        let uuid = m2 ? m2[1] : ''

        return uuid
    })
}

let genQR = (uuid) => {
    let u = 'https://login.weixin.qq.com/qrcode/' + uuid

    let params = {
        t: 'webwx'
    }

    return new Promise((resolve, reject) => {
        request(serialize(u, params)).then((data) => {
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

let scanLogin = (uuid) => {
    let u = 'https://login.weixin.qq.com/cgi-bin/mmwebwx-bin/login'

    let params = {
        tip: _tip,
        uuid: uuid
    }

    request(serialize(u, params)).then((data) => {
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

let getBaseInfo = (u) => {
    return new Promise((resolve, reject) => {
        console.log('正在登陆...'.green)

        request(u).then((data) => {
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
let getProfile = () => {
    let u = _baseUrl + '/webwxinit'

    let params = {
        pass_ticket: _ticket,
        skey: _skey
    }

    let data = {
        BaseRequest: _baseRequest
    }

    let headers = {
        'Content-Type': 'application/json; charset=UTF-8'
    }

    return new Promise((resolve, reject) => {
        request(serialize(u, params), data, headers)
            .then((data) => {
                if(_debug) fs.writeFileSync('./_profile.json', data)

                data = JSON.parse(data.toString())

                let ret = data.BaseResponse.Ret

                // 个人信息
                if(ret == 0) resolve(data.User)
                else reject(Error(_debug ? data.BaseResponse.ErrMsg : '初始化微信失败'))
            }, reject)
    })
}

let getContact = () => {
    let u = _baseUrl + '/webwxgetcontact'

    let params = {
        pass_ticket: _ticket,
        skey: _skey
    }

    // 必须带上cookie，不然拿不到联系人列表
    let headers = {
        'Cookie': `wxuin=${_cookie['wxuin']}; wxsid=${_cookie['wxsid']};
            wxloadtime=${_cookie['wxloadtime']}; webwx_data_ticket=${_cookie['webwx_data_ticket']};
            webwxuvid=${_cookie['webwxuvid']}`,
        'Content-Type': 'application/json; charset=UTF-8'
    }

    return new Promise((resolve, reject) => {
        request(serialize(u, params), null, headers).then((data) => {
            if(_debug) fs.writeFileSync('./_wxcontact.json', data)

            data = JSON.parse(data.toString())

            let ret = data.BaseResponse.Ret
            let errMsg = data.BaseResponse.ErrMsg

            if(ret == 0) resolve(data.MemberList)
            else reject(_debug && errMsg ? errMsg: '获取联系人列表失败')
        }, reject)
    })
}

let creteRoom = (userNames) => {
    let u = _baseUrl + '/webwxcreatechatroom'

    let params = {
        pass_ticket: _ticket
    }

    let memberList = userNames.map((nm) => {return {'UserName': nm}})

    let data = {
        BaseRequest: _baseRequest,
        MemberCount: memberList.length,
        MemberList: memberList,
        Topic: ''
    }

    let headers = {
        'Cookie': `wxuin=${_cookie['wxuin']}; wxsid=${_cookie['wxsid']};
            wxloadtime=${_cookie['wxloadtime']}; webwx_data_ticket=${_cookie['webwx_data_ticket']};
            webwxuvid=${_cookie['webwxuvid']}`,
        'Content-Type': 'application/json; charset=UTF-8'
    }

    return new Promise((resolve, reject) => {
        request(serialize(u, params), data, headers).then((data) => {
            data = JSON.parse(data.toString())

            // if(_debug) console.log('creteRoom data:'.green, data)

            let ret = data.BaseResponse.Ret
            let errMsg = data.BaseResponse.ErrMsg
            let list = data['MemberList']

            if(ret == 0) {
                _.each(list, (member) => {
                    if(member.MemberStatus == 4) _deletedList.push(member['UserName'])
                })

                _roomName = data['ChatRoomName']

                console.log('找到【%d】位好友删除你'.cyan, _deletedList.length)

                resolve(userNames)
            } else {
                reject('建群失败：' + (errMsg || '未知原因'))
            }
        }, reject)
    })
}

let add2Room = (userNames) => {
    let u = _baseUrl + '/webwxupdatechatroom'

    let params = {
        pass_ticket: _ticket,
        fun: 'addmember'
    }

    let data = {
        BaseRequest: _baseRequest,
        ChatRoomName: _roomName,
        AddMemberList: userNames.join(',')
    }

    let headers = {
        'Cookie': `wxuin=${_cookie['wxuin']}; wxsid=${_cookie['wxsid']};
            wxloadtime=${_cookie['wxloadtime']}; webwx_data_ticket=${_cookie['webwx_data_ticket']};
            webwxuvid=${_cookie['webwxuvid']}`,
        'Content-Type': 'application/json; charset=UTF-8'
    }

    return new Promise((resolve, reject) => {
        request(serialize(u, params), data, headers).then((data) => {
            data = JSON.parse(data.toString())

            // if(_debug) console.log('add2Room data:'.green, data)

            let ret = data.BaseResponse.Ret
            let errMsg = data.BaseResponse.ErrMsg
            let list = data['MemberList']

            if(ret == 0) {
                _.each(list, (member) => {
                    if(member.MemberStatus == 4) _deletedList.push(member['UserName'])
                })

                console.log('找到【%d】位好友删除你'.cyan, _deletedList.length)

                resolve(userNames)
            } else {
                reject('加群失败：' + (errMsg || '未知原因'))
            }
        }, reject)
    })
}

let removeFromRoom = (userNames) => {
    let u = _baseUrl + '/webwxupdatechatroom'

    let params = {
        pass_ticket: _ticket,
        fun: 'delmember'
    }

    let data = {
        BaseRequest: _baseRequest,
        ChatRoomName: _roomName,
        DelMemberList: userNames.join(',')
    }

    let headers = {
        'Cookie': `wxuin=${_cookie['wxuin']}; wxsid=${_cookie['wxsid']};
            wxloadtime=${_cookie['wxloadtime']}; webwx_data_ticket=${_cookie['webwx_data_ticket']};
            webwxuvid=${_cookie['webwxuvid']}`,
        'Content-Type': 'application/json; charset=UTF-8'
    }

    return new Promise((resolve, reject) => {
        request(serialize(u, params), data, headers).then((data) => {
            data = JSON.parse(data.toString())

            if(_debug) console.log('removeFromRoom data:'.green, data)

            let ret = data['BaseResponse']['Ret']
            let errMsg = data['BaseResponse']['ErrMsg']

            if(ret == 0) resolve()
            else reject('移除群失败：' + (errMsg || '未知原因'))
        })
    })
}

let checkWhoDeletedMe = (members) => {
    console.log('你微信一共有【%s】位好友'.cyan, members.length)

    let usersMap = {}
    let groupNum = Math.ceil(members.length / MAX_GROUP_NUM)
    let group = 1

    if(_debug) console.log('好友被分为%d组，每组最多%d人', groupNum, MAX_GROUP_NUM)

    let check = () => {
        if(group == groupNum) {
            if(!_deletedList.length) return console.log('恭喜，人品真好，没有好友删除你！'.green)

            _deletedList = _.map(_deletedList, (v) => {
                return usersMap[v]['NickName']
            })

            console.log('查询完毕，被【%d】位好友删除'.cyan, _deletedList.length)
            console.log('==========删除你的好友============')
            console.log(_deletedList.join('\n'))
            return
        }

        ++group

        let users = members.splice(0, MAX_GROUP_NUM)
        let userNames = _.map(users, (v) => {
            usersMap[v['UserName']] = v
            return v.UserName
        })
        let createOrAdd = _roomName ? add2Room : creteRoom

        console.log('正在查询删除你的好友...'.cyan)

        createOrAdd(userNames)
            .then(wait(SEARCH_INTERVAL))
            .then(removeFromRoom)
            .then(wait(SEARCH_INTERVAL))
            .then(check)
            .catch(printErr)
    }

    check()
}

process.on('login:success', (redirectUri) => {
    _baseUrl = redirectUri.slice(0, redirectUri.lastIndexOf('/'))

    // @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise
    getBaseInfo(redirectUri)
        .then((info) => {
            return Promise.all([getProfile(), getContact()])
        })
        // 挑出好友列表
        .then((values) => {
            let profile = values[0]
            let allContacts = values[1]

            return _.filter(allContacts, (v) => {
                return v['VerifyFlag'] == 0 // 个人账号
                    && !_.includes(SPEC_USERS, v['UserName']) // 特殊账号
                    && !/@@/.test(v['UserName']) // 群聊
                    && v['UserName'] !== profile['UserName'] // 自己
            })
        }, printErr)
        .then(checkWhoDeletedMe)

    fs.unlinkSync(QR_IMAGE_PATH)
})

process.on('login:fail', (uuid, code) => {
    let msg = code == 201 ? '成功扫描，请在手机上点击确认登陆'.green : '登陆失败，即将重试...'.red

    console.log(msg)

    setTimeout(() => {
        scanLogin(uuid)
    }, 500)
})

let run = () => {
    _debug = process.argv[2] || false

    getUUID().then((uuid) => {
        genQR(uuid).then(open, printErr)
        scanLogin(uuid)
    }, printErr)
}

run()
