/**
 * contacts.js — Stage A: 通讯录 + 主页范式
 *
 * by 闻香 for 咪
 *
 * 这个文件单独承担 Stage A 的全部职责:
 *   1. contactList 数据层 (全局, 跨 session)
 *   2. session 模型扩展 participantContactIds 字段
 *   3. overview 主页视图 (默认入口, 列出所有联系人+群聊)
 *   4. 联系人 CRUD UI (新建/编辑/删除)
 *   5. 启动时默认进 overview, 不再自动进入某个 session
 *   6. 聊天页 header 注入"返回overview"按钮
 *
 * 设计原则:
 *   - 完全用JS注入DOM, 不需要修改index.html (除了script标签)
 *   - 完全用JS注入CSS, 用变量保持主题一致
 *   - 兼容现有的 session model 和 group-chat.js
 *   - "进入聊天 = 改hash + reload" (沿用原版的session切换机制)
 */

(function() {
    'use strict';

    // ====================================================================
    // 0. 数据层
    // ====================================================================

    var contactList = [];          // 全局联系人列表
    var CONTACTS_KEY = 'contactList'; // localforage key (会加 APP_PREFIX 前缀)

    function _key(k) {
        return (window.APP_PREFIX || 'CHAT_APP_V3_') + k;
    }

    async function loadContacts() {
        if (!window.localforage) return [];
        try {
            var saved = await localforage.getItem(_key(CONTACTS_KEY));
            contactList = Array.isArray(saved) ? saved : [];
            // 加载头像 (大文件单独存)
            await Promise.all(contactList.map(function(c) {
                if (c.avatarRef) {
                    return localforage.getItem(c.avatarRef).then(function(av) {
                        c.avatar = av || null;
                    }).catch(function() { c.avatar = null; });
                }
            }));
            return contactList;
        } catch (e) {
            console.warn('[contacts] load 失败:', e);
            contactList = [];
            return [];
        }
    }

    async function saveContacts() {
        if (!window.localforage) return;
        try {
            // 只存元数据, 头像引用
            var toSave = contactList.map(function(c) {
                if (!c.id) c.id = 'cnt_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
                return {
                    id: c.id,
                    name: c.name,
                    avatarRef: c.avatarRef || ('cavt_' + c.id),
                    note: c.note || '',
                    birthday: c.birthday || '',
                    relation: c.relation || '',
                    createdAt: c.createdAt || Date.now()
                };
            });
            await localforage.setItem(_key(CONTACTS_KEY), toSave);
            // 头像单独存
            await Promise.all(contactList.map(function(c) {
                if (c.avatar && c.avatarRef) {
                    return localforage.setItem(c.avatarRef, c.avatar).catch(function() {});
                }
            }));
        } catch (e) {
            console.warn('[contacts] save 失败:', e);
        }
    }

    function findContactById(id) {
        return contactList.find(function(c) { return c.id === id; }) || null;
    }

    function createContact(data) {
        var c = {
            id: 'cnt_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
            name: (data.name || '').trim() || '未命名',
            avatar: data.avatar || null,
            note: data.note || '',
            birthday: data.birthday || '',
            relation: data.relation || '',
            createdAt: Date.now()
        };
        c.avatarRef = 'cavt_' + c.id;
        contactList.push(c);
        saveContacts();
        return c;
    }

    function updateContact(id, patch) {
        var c = findContactById(id);
        if (!c) return null;
        if (typeof patch.name === 'string') c.name = patch.name.trim() || c.name;
        if ('avatar' in patch) c.avatar = patch.avatar;
        if (typeof patch.note === 'string') c.note = patch.note;
        if (typeof patch.birthday === 'string') c.birthday = patch.birthday;
        if (typeof patch.relation === 'string') c.relation = patch.relation;
        saveContacts();
        return c;
    }

    async function deleteContact(id) {
        var idx = contactList.findIndex(function(c) { return c.id === id; });
        if (idx === -1) return false;
        var c = contactList[idx];
        contactList.splice(idx, 1);
        try {
            if (c.avatarRef && window.localforage) {
                await localforage.removeItem(c.avatarRef);
            }
        } catch (e) {}
        await saveContacts();
        return true;
    }

    // ====================================================================
    // 1. Session ↔ Contact 桥接
    // ====================================================================

    // 为某些 contactId 找(或新建)对应的 session
    async function getOrCreateSessionForContacts(contactIds, opts) {
        opts = opts || {};
        if (!Array.isArray(contactIds) || contactIds.length === 0) return null;
        // 排序确保参与者集合的稳定 hash
        var sorted = contactIds.slice().sort();

        // 找现有 session
        if (typeof sessionList !== 'undefined' && sessionList) {
            var found = sessionList.find(function(s) {
                if (!s.participantContactIds) return false;
                var sids = s.participantContactIds.slice().sort();
                return sids.length === sorted.length &&
                    sids.every(function(id, i) { return id === sorted[i]; });
            });
            if (found) return found;
        }

        // 不存在 → 新建
        var newId = Date.now().toString(36) + Math.random().toString(36).substr(2);
        var contactNames = contactIds.map(function(cid) {
            var c = findContactById(cid);
            return c ? c.name : '?';
        });
        var sessionName = opts.name || (contactNames.length === 1
            ? '与 ' + contactNames[0] + ' 的对话'
            : contactNames.join('、'));
        var newSession = {
            id: newId,
            name: sessionName,
            createdAt: Date.now(),
            participantContactIds: contactIds.slice(),
            // 给 group-chat.js 用的字段, 兼容
            members: contactIds.length > 1 ? contactIds.map(function(cid) {
                var c = findContactById(cid);
                return c ? { id: c.id, name: c.name, avatarRef: c.avatarRef } : null;
            }).filter(Boolean) : [],
            groupSettings: { showAvatar: true, showName: true }
        };
        if (typeof sessionList !== 'undefined') {
            sessionList.push(newSession);
            if (window.localforage) {
                await localforage.setItem(_key('sessionList'), sessionList);
            }
        }
        return newSession;
    }

    // 进入某个 session (改hash + reload, 沿用原版机制)
    function enterSession(sessionId) {
        window.location.hash = sessionId;
        // 给 view mode 一个信号: 用户主动选择了进入聊天
        try { sessionStorage.setItem('milk_view_mode', 'chat'); } catch(e){}
        window.location.reload();
    }

    // ====================================================================
    // 2. CSS 注入
    // ====================================================================

    function injectStyles() {
        if (document.getElementById('contacts-style')) return;
        var css = `
.overview-root {
    position: fixed; inset: 0;
    background: var(--primary-bg, #fff);
    z-index: 100;
    display: flex; flex-direction: column;
    font-family: var(--font-family, inherit);
}
.overview-header {
    padding: 14px 18px 10px;
    border-bottom: 1px solid var(--border-color, #eee);
    background: var(--secondary-bg, #fafafa);
    display: flex; align-items: center; gap: 10px;
}
.overview-header h1 {
    margin: 0; font-size: 18px; font-weight: 700;
    color: var(--text-primary, #222); letter-spacing: 1px;
    flex: 1;
}
.overview-header-btn {
    border: none; cursor: pointer;
    background: rgba(var(--accent-color-rgb, 197,164,126), 0.12);
    color: var(--accent-color, #c5a47e);
    border-radius: 10px; padding: 8px 12px;
    font-size: 13px; font-weight: 500;
    display: flex; align-items: center; gap: 6px;
    transition: all 0.2s;
}
.overview-header-btn:hover { background: rgba(var(--accent-color-rgb, 197,164,126), 0.22); }
.overview-tabs {
    display: flex; gap: 0;
    border-bottom: 1px solid var(--border-color, #eee);
    background: var(--secondary-bg, #fafafa);
}
.overview-tab {
    flex: 1; padding: 11px 0; text-align: center;
    font-size: 13px; font-weight: 500;
    color: var(--text-secondary, #888); cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
}
.overview-tab.active {
    color: var(--accent-color, #c5a47e);
    border-bottom-color: var(--accent-color, #c5a47e);
}
.overview-list {
    flex: 1; overflow-y: auto;
    padding: 8px 0;
}
.overview-item {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 18px; cursor: pointer;
    transition: background 0.15s;
    border-bottom: 1px solid var(--border-color, #f2f2f2);
}
.overview-item:hover { background: rgba(var(--accent-color-rgb, 197,164,126), 0.05); }
.overview-item-avatar {
    width: 46px; height: 46px; border-radius: 50%;
    background: rgba(var(--accent-color-rgb, 197,164,126), 0.15);
    flex-shrink: 0; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    font-weight: 600; color: var(--accent-color, #c5a47e);
}
.overview-item-avatar img { width: 100%; height: 100%; object-fit: cover; }
.overview-item-body { flex: 1; min-width: 0; }
.overview-item-name {
    font-size: 14px; font-weight: 600;
    color: var(--text-primary, #222);
    margin-bottom: 3px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.overview-item-sub {
    font-size: 12px; color: var(--text-secondary, #999);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.overview-item-meta {
    font-size: 11px; color: var(--text-secondary, #aaa);
    text-align: right;
}
.overview-empty {
    text-align: center; padding: 60px 30px;
    color: var(--text-secondary, #999); font-size: 13px;
}
.overview-empty .icon {
    font-size: 36px; opacity: 0.4; margin-bottom: 14px;
}
.overview-fab {
    position: fixed; bottom: 28px; right: 22px;
    width: 52px; height: 52px; border-radius: 50%;
    background: var(--accent-color, #c5a47e); color: #fff;
    border: none; cursor: pointer; z-index: 105;
    box-shadow: 0 6px 22px rgba(0,0,0,0.18);
    font-size: 22px; transition: transform 0.2s;
}
.overview-fab:hover { transform: scale(1.06); }
.overview-fab-menu {
    position: fixed; bottom: 90px; right: 22px;
    background: var(--secondary-bg, #fff);
    border: 1px solid var(--border-color, #eee);
    border-radius: 12px; padding: 6px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    z-index: 105; display: none;
    min-width: 180px;
}
.overview-fab-menu.open { display: block; }
.overview-fab-menu-item {
    padding: 10px 14px; cursor: pointer;
    font-size: 13px; color: var(--text-primary, #222);
    border-radius: 8px;
    display: flex; align-items: center; gap: 10px;
}
.overview-fab-menu-item:hover { background: rgba(var(--accent-color-rgb, 197,164,126), 0.1); }

/* 聊天页注入的"返回overview"按钮 */
.chat-back-to-overview {
    position: fixed; top: 14px; left: 14px;
    width: 38px; height: 38px; border-radius: 50%;
    background: var(--secondary-bg, rgba(255,255,255,0.9));
    border: 1px solid var(--border-color, #eee);
    color: var(--accent-color, #c5a47e);
    cursor: pointer; z-index: 50;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    backdrop-filter: blur(8px);
}
.chat-back-to-overview:hover { transform: scale(1.05); }

/* 联系人编辑modal */
.contact-edit-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.4); backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
}
.contact-edit-card {
    background: var(--secondary-bg, #fff);
    border-radius: 18px; padding: 22px 22px 18px;
    width: 92%; max-width: 380px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.28);
}
.contact-edit-card h2 {
    margin: 0 0 14px; font-size: 16px; font-weight: 700;
    color: var(--text-primary, #222); display: flex; align-items: center; gap: 8px;
}
.contact-edit-avatar-pick {
    width: 70px; height: 70px; border-radius: 50%;
    margin: 0 auto 14px; cursor: pointer;
    background: var(--primary-bg, #fafafa);
    border: 2px dashed var(--border-color, #ddd);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden; position: relative;
}
.contact-edit-avatar-pick img { width: 100%; height: 100%; object-fit: cover; }
.contact-edit-field { margin-bottom: 11px; }
.contact-edit-field label {
    display: block; font-size: 11px; color: var(--text-secondary, #888);
    margin-bottom: 4px; letter-spacing: 0.3px;
}
.contact-edit-field input, .contact-edit-field textarea, .contact-edit-field select {
    width: 100%; box-sizing: border-box;
    padding: 9px 11px; border: 1px solid var(--border-color, #ddd);
    border-radius: 9px; background: var(--primary-bg, #fff);
    color: var(--text-primary, #222);
    font-size: 13px; font-family: inherit;
}
.contact-edit-field textarea { resize: vertical; min-height: 56px; }
.contact-edit-actions {
    display: flex; gap: 8px; margin-top: 16px;
}
.contact-edit-actions button {
    flex: 1; padding: 10px; border-radius: 10px;
    font-size: 13px; cursor: pointer; font-family: inherit;
    border: none;
}
.contact-edit-actions .cancel {
    background: var(--primary-bg, #f3f3f3);
    color: var(--text-secondary, #888);
    border: 1px solid var(--border-color, #ddd);
}
.contact-edit-actions .save {
    background: var(--accent-color, #c5a47e); color: #fff;
    font-weight: 600;
}
.contact-edit-actions .delete {
    background: transparent; color: #d65f5f;
    border: 1px solid #e8c5c5;
}
`;
        var style = document.createElement('style');
        style.id = 'contacts-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ====================================================================
    // 3. Overview UI
    // ====================================================================

    var overviewState = { tab: 'chats' }; // 'chats' or 'contacts'
    var fabMenuOpen = false;

    function buildOverviewDOM() {
        if (document.getElementById('overview-root')) return;
        var root = document.createElement('div');
        root.id = 'overview-root';
        root.className = 'overview-root';
        root.style.display = 'none';
        root.innerHTML = `
<div class="overview-header">
    <h1>传讯</h1>
    <button class="overview-header-btn" id="overview-settings-btn" title="原版设置入口">
        <i class="fas fa-cog"></i>
    </button>
</div>
<div class="overview-tabs">
    <div class="overview-tab active" data-tab="chats">聊天</div>
    <div class="overview-tab" data-tab="contacts">通讯录</div>
</div>
<div class="overview-list" id="overview-list"></div>
<button class="overview-fab" id="overview-fab" title="新建">+</button>
<div class="overview-fab-menu" id="overview-fab-menu">
    <div class="overview-fab-menu-item" data-action="new-contact">
        <i class="fas fa-user-plus" style="width:18px;color:var(--accent-color);"></i>
        <span>新建联系人</span>
    </div>
    <div class="overview-fab-menu-item" data-action="new-group">
        <i class="fas fa-users" style="width:18px;color:var(--accent-color);"></i>
        <span>新建群聊</span>
    </div>
</div>
`;
        document.body.appendChild(root);

        // tab 切换
        root.querySelectorAll('.overview-tab').forEach(function(t) {
            t.addEventListener('click', function() {
                overviewState.tab = t.getAttribute('data-tab');
                root.querySelectorAll('.overview-tab').forEach(function(x) {
                    x.classList.toggle('active', x === t);
                });
                renderOverviewList();
            });
        });

        // 设置按钮：直接打开原版的settings modal
        document.getElementById('overview-settings-btn').addEventListener('click', function() {
            var sm = document.getElementById('settings-modal');
            if (sm && typeof showModal === 'function') showModal(sm);
        });

        // FAB 菜单
        document.getElementById('overview-fab').addEventListener('click', function() {
            fabMenuOpen = !fabMenuOpen;
            document.getElementById('overview-fab-menu').classList.toggle('open', fabMenuOpen);
        });
        document.addEventListener('click', function(e) {
            if (fabMenuOpen && !e.target.closest('.overview-fab-menu') && !e.target.closest('#overview-fab')) {
                fabMenuOpen = false;
                document.getElementById('overview-fab-menu').classList.remove('open');
            }
        });
        document.querySelectorAll('.overview-fab-menu-item').forEach(function(item) {
            item.addEventListener('click', function() {
                fabMenuOpen = false;
                document.getElementById('overview-fab-menu').classList.remove('open');
                var action = item.getAttribute('data-action');
                if (action === 'new-contact') openContactEditModal(null);
                else if (action === 'new-group') {
                    // Stage B 内容: 暂时弹个提示
                    if (typeof showNotification === 'function') {
                        showNotification('群聊创建功能在Stage B开通', 'info');
                    } else {
                        alert('群聊创建功能即将开放（Stage B）');
                    }
                }
            });
        });
    }

    function renderOverviewList() {
        var list = document.getElementById('overview-list');
        if (!list) return;

        if (overviewState.tab === 'contacts') {
            // 渲染联系人列表
            if (contactList.length === 0) {
                list.innerHTML = `
<div class="overview-empty">
    <div class="icon"><i class="fas fa-address-book"></i></div>
    <div>通讯录还是空的</div>
    <div style="margin-top:6px;font-size:11px;opacity:0.7;">点右下角 + 添加你的第一个联系人</div>
</div>`;
                return;
            }
            list.innerHTML = contactList.map(function(c) {
                var initial = (c.name || '?').charAt(0).toUpperCase();
                var avatarHtml = c.avatar
                    ? '<img src="' + c.avatar + '">'
                    : '<span>' + initial + '</span>';
                var sub = [c.relation, c.note].filter(Boolean).join(' · ') || '（无备注）';
                return `
<div class="overview-item" data-contact-id="${c.id}">
    <div class="overview-item-avatar">${avatarHtml}</div>
    <div class="overview-item-body">
        <div class="overview-item-name">${escapeHtml(c.name)}</div>
        <div class="overview-item-sub">${escapeHtml(sub)}</div>
    </div>
</div>`;
            }).join('');
            // 点联系人 → 打开私聊
            list.querySelectorAll('[data-contact-id]').forEach(function(el) {
                el.addEventListener('click', async function() {
                    var cid = el.getAttribute('data-contact-id');
                    var session = await getOrCreateSessionForContacts([cid]);
                    if (session) enterSession(session.id);
                });
            });
            // 长按 (1秒) 进入编辑
            list.querySelectorAll('[data-contact-id]').forEach(function(el) {
                var timer = null;
                el.addEventListener('mousedown', function() {
                    timer = setTimeout(function() {
                        var cid = el.getAttribute('data-contact-id');
                        openContactEditModal(findContactById(cid));
                    }, 600);
                });
                el.addEventListener('mouseup', function() { if (timer) clearTimeout(timer); });
                el.addEventListener('mouseleave', function() { if (timer) clearTimeout(timer); });
                el.addEventListener('touchstart', function() {
                    timer = setTimeout(function() {
                        var cid = el.getAttribute('data-contact-id');
                        openContactEditModal(findContactById(cid));
                    }, 600);
                });
                el.addEventListener('touchend', function() { if (timer) clearTimeout(timer); });
            });

        } else {
            // 渲染聊天列表 (现有 sessions)
            var sessions = (typeof sessionList !== 'undefined' ? sessionList : []) || [];
            if (sessions.length === 0) {
                list.innerHTML = `
<div class="overview-empty">
    <div class="icon"><i class="fas fa-comment-dots"></i></div>
    <div>还没有任何聊天</div>
    <div style="margin-top:6px;font-size:11px;opacity:0.7;">先去通讯录建联系人, 点ta即可开聊</div>
</div>`;
                return;
            }
            // 按 createdAt 倒序
            var sorted = sessions.slice().sort(function(a, b) {
                return (b.createdAt || 0) - (a.createdAt || 0);
            });
            list.innerHTML = sorted.map(function(s) {
                var participants = (s.participantContactIds || []).map(findContactById).filter(Boolean);
                var isGroup = participants.length > 1 || (s.members && s.members.length > 1);
                var name = s.name || '未命名会话';
                var subParts = [];
                if (isGroup) subParts.push('群聊 · ' + (participants.length || s.members.length || 0) + '人');
                else if (participants.length === 1) subParts.push('私聊');
                else subParts.push('梦角会话');
                var ts = s.createdAt ? new Date(s.createdAt).toLocaleDateString('zh-CN', {month:'2-digit',day:'2-digit'}) : '';

                var avatarHtml;
                if (participants.length === 1 && participants[0].avatar) {
                    avatarHtml = '<img src="' + participants[0].avatar + '">';
                } else if (participants.length === 1) {
                    avatarHtml = '<span>' + (participants[0].name || '?').charAt(0).toUpperCase() + '</span>';
                } else if (isGroup) {
                    avatarHtml = '<i class="fas fa-users"></i>';
                } else {
                    avatarHtml = '<i class="fas fa-comment"></i>';
                }

                return `
<div class="overview-item" data-session-id="${s.id}">
    <div class="overview-item-avatar">${avatarHtml}</div>
    <div class="overview-item-body">
        <div class="overview-item-name">${escapeHtml(name)}</div>
        <div class="overview-item-sub">${escapeHtml(subParts.join(' · '))}</div>
    </div>
    <div class="overview-item-meta">${ts}</div>
</div>`;
            }).join('');
            // 点 → 进入聊天
            list.querySelectorAll('[data-session-id]').forEach(function(el) {
                el.addEventListener('click', function() {
                    var sid = el.getAttribute('data-session-id');
                    enterSession(sid);
                });
            });
        }
    }

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, function(c) {
            return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
        });
    }

    // ====================================================================
    // 4. 联系人编辑 Modal
    // ====================================================================

    var _avatarDataUrl = null;
    var _editingContactId = null;

    function openContactEditModal(contact) {
        _editingContactId = contact ? contact.id : null;
        _avatarDataUrl = contact ? contact.avatar : null;

        // 移除旧的
        var old = document.getElementById('contact-edit-overlay');
        if (old) old.remove();

        var overlay = document.createElement('div');
        overlay.className = 'contact-edit-overlay';
        overlay.id = 'contact-edit-overlay';
        var title = contact ? '编辑联系人' : '新建联系人';
        var avatarPreview = _avatarDataUrl
            ? '<img src="' + _avatarDataUrl + '">'
            : '<i class="fas fa-camera" style="font-size:22px;color:#bbb;"></i>';
        overlay.innerHTML = `
<div class="contact-edit-card">
    <h2><i class="fas fa-user-circle"></i> ${title}</h2>
    <div class="contact-edit-avatar-pick" id="contact-avatar-pick">
        ${avatarPreview}
    </div>
    <input type="file" id="contact-avatar-input" accept="image/*" style="display:none;">
    <div class="contact-edit-field">
        <label>名字 *</label>
        <input type="text" id="contact-name" maxlength="30" value="${contact ? escapeHtml(contact.name) : ''}">
    </div>
    <div class="contact-edit-field">
        <label>备注</label>
        <textarea id="contact-note" maxlength="200" placeholder="关于ta的一句话…">${contact ? escapeHtml(contact.note || '') : ''}</textarea>
    </div>
    <div class="contact-edit-field">
        <label>生日</label>
        <input type="date" id="contact-birthday" value="${contact ? (contact.birthday || '') : ''}">
    </div>
    <div class="contact-edit-field">
        <label>关系</label>
        <input type="text" id="contact-relation" maxlength="20" placeholder="例如: 老公 / 朋友 / 角色 / 原创" value="${contact ? escapeHtml(contact.relation || '') : ''}">
    </div>
    <div class="contact-edit-actions">
        <button class="cancel" id="contact-edit-cancel">取消</button>
        ${contact ? '<button class="delete" id="contact-edit-delete">删除</button>' : ''}
        <button class="save" id="contact-edit-save">保存</button>
    </div>
</div>
`;
        document.body.appendChild(overlay);

        document.getElementById('contact-avatar-pick').addEventListener('click', function() {
            document.getElementById('contact-avatar-input').click();
        });
        document.getElementById('contact-avatar-input').addEventListener('change', function(e) {
            var file = e.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function(ev) {
                _avatarDataUrl = ev.target.result;
                document.getElementById('contact-avatar-pick').innerHTML = '<img src="' + _avatarDataUrl + '">';
            };
            reader.readAsDataURL(file);
        });
        document.getElementById('contact-edit-cancel').addEventListener('click', function() {
            overlay.remove();
        });
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) overlay.remove();
        });
        document.getElementById('contact-edit-save').addEventListener('click', async function() {
            var name = (document.getElementById('contact-name').value || '').trim();
            if (!name) { alert('请填写名字'); return; }
            var data = {
                name: name,
                avatar: _avatarDataUrl,
                note: document.getElementById('contact-note').value,
                birthday: document.getElementById('contact-birthday').value,
                relation: document.getElementById('contact-relation').value
            };
            if (_editingContactId) {
                updateContact(_editingContactId, data);
            } else {
                createContact(data);
            }
            overlay.remove();
            renderOverviewList();
        });
        var delBtn = document.getElementById('contact-edit-delete');
        if (delBtn) {
            delBtn.addEventListener('click', async function() {
                if (!confirm('确定删除这个联系人吗？相关聊天记录不会被删除, 但会失去关联。')) return;
                await deleteContact(_editingContactId);
                overlay.remove();
                renderOverviewList();
            });
        }
    }

    // ====================================================================
    // 5. View Mode 控制 + Boot 接管
    // ====================================================================

    function showOverview() {
        var ov = document.getElementById('overview-root');
        if (!ov) {
            buildOverviewDOM();
            ov = document.getElementById('overview-root');
        }
        ov.style.display = 'flex';
        renderOverviewList();
        try { sessionStorage.setItem('milk_view_mode', 'overview'); } catch(e){}
        // 清掉URL hash, 表明现在不在某个特定session
        if (window.location.hash) {
            history.replaceState(null, '', window.location.pathname);
        }
    }

    function hideOverview() {
        var ov = document.getElementById('overview-root');
        if (ov) ov.style.display = 'none';
    }

    function injectBackToOverviewButton() {
        if (document.getElementById('chat-back-to-overview-btn')) return;
        var btn = document.createElement('button');
        btn.id = 'chat-back-to-overview-btn';
        btn.className = 'chat-back-to-overview';
        btn.title = '返回主页';
        btn.innerHTML = '<i class="fas fa-arrow-left"></i>';
        btn.addEventListener('click', function() {
            showOverview();
        });
        document.body.appendChild(btn);
    }

    function hideBackToOverviewButton() {
        var btn = document.getElementById('chat-back-to-overview-btn');
        if (btn) btn.style.display = 'none';
    }

    // ====================================================================
    // 6. Boot
    // ====================================================================

    async function boot() {
        injectStyles();
        buildOverviewDOM();
        await loadContacts();

        // 决定初始view mode
        var urlHash = window.location.hash.substring(1);
        var lastMode = null;
        try { lastMode = sessionStorage.getItem('milk_view_mode'); } catch(e){}

        // 如果URL有有效hash → 进聊天; 否则 → 进overview
        var goChat = false;
        if (urlHash && typeof sessionList !== 'undefined' && sessionList) {
            if (sessionList.some(function(s) { return s.id === urlHash; })) {
                goChat = true;
            }
        }

        if (goChat) {
            // 在聊天 view: 注入"返回"按钮
            hideOverview();
            injectBackToOverviewButton();
        } else {
            // 在 overview view
            showOverview();
        }
    }

    // 等 initializeSession + loadContacts 都完成后再 boot
    function tryBoot(retries) {
        if (typeof sessionList !== 'undefined' && (sessionList === null || Array.isArray(sessionList))) {
            boot();
        } else if (retries > 0) {
            setTimeout(function() { tryBoot(retries - 1); }, 200);
        } else {
            // 兜底
            boot();
        }
    }
    document.addEventListener('DOMContentLoaded', function() {
        tryBoot(40);
    });

    // ====================================================================
    // 7. 导出全局接口
    // ====================================================================

    window.contactsModule = {
        list: function() { return contactList.slice(); },
        find: findContactById,
        create: createContact,
        update: updateContact,
        delete: deleteContact,
        showOverview: showOverview,
        hideOverview: hideOverview,
        openEditor: openContactEditModal,
        getOrCreateSessionForContacts: getOrCreateSessionForContacts,
        renderOverview: renderOverviewList
    };

})();
