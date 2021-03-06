const EXPORT = ["HttpWatcher"];

const HTTP_ON_MODIFY_REQUEST = "http-on-modify-request";
const HTTP_ON_EXAMINE_RESPONSE = "http-on-examine-response";

var HttpWatcher = {
    get taskSet HW_get_taskSet() {
        let taskSet = null;
        if (shared.has("HttpWatcherTaskSet")) {
            taskSet = shared.get("HttpWatcherTaskSet");
        } else {
            taskSet = {};
            shared.set("HttpWatcherTaskSet", taskSet);
        }
        delete this.taskSet;
        return this.taskSet = taskSet;
    },

    pushTask: function HW__pushTask(url, data) {
        //if (url in this.taskSet) return;
        this.taskSet[url] = data;
    },

    popTask: function HW__popTask(url) {
        let task = null;
        if (url in this.taskSet) {
            task = this.taskSet[url];
            delete this.taskSet[url];
        }
        return task;
    },

    onRequest: function HW_onRequest(channel) {
        let data = this._getPostData(channel);
        this.pushTask(data.url, data);
    },

    _getPostData: function HW__getPostData(channel) {
        if (!(channel instanceof Ci.nsIUploadChannel)) return;
        let rawStream = channel.uploadStream;
        if (!(rawStream instanceof Ci.nsISeekableStream)) return;
        let hasHeaders = rawStream instanceof Ci.nsIMIMEInputStream;
        let stream = Cc["@mozilla.org/scriptableinputstream;1"].
                     createInstance(Ci.nsIScriptableInputStream);
        stream.init(rawStream);
        let body = stream.read(stream.available());
        rawStream.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
        if (hasHeaders)
            body = body.replace(/^[\s\S]*?\r\n\r\n/, "");
        return this._toMap(body);
    },

    _toMap: function HW__toMap(string) {
        let result = {};
        string.replace(/\+/g, "%20").split("&").forEach(function (pair) {
            let [key, value] = pair.split("=");
            try {
                value = decodeURIComponent(value);
            } catch (ex) {}
            result[key] = value;
        });
        return result;
    },

    onResponse: function HW_onResponse(channel) {
        let url = this._getBookmakedURL(channel);
        if (!url) return;
        let task = this.popTask(url);
        if (!task) return;
        this.performTask(task);
    },

    _getBookmakedURL: function HW__getBookmarkedURL(channel) {
        try {
            return channel.getResponseHeader("X-Bookmark-URL");
        } catch (ex) {
            return null;
        }
    },

    performTask: function HW_performTask(task) {
        // ブックマーク成功したら、sync する
        // これにより、リモートとのデータの同期がとれる
        // XXX: Sync に依存してしまう
        let listener = Sync.createListener("complete", function onSync() {
            p('Sync completed');
            listener.unlisten();
            HTTPCache.entry.cache.clear(task.url);
            if (!Model.Bookmark.findByUrl(task.url).length) {
                p(task.url + ' is not registered.  Retry sync.');
                // 同期が間に合わなかったら少し待ってもう一度だけ同期する。
                setTimeout(method(Sync, 'sync'), 2000);
            }
        }, null, 0, false);
        Sync.sync();

        let bookmark = Model.Bookmark.findByUrl(task.url)[0];
        if (bookmark) {
            // すでに存在するブックマークは Sync で
            // 同期できないので、ここで DB を更新しておく。
            if (task.title)
                bookmark.title = task.title;
            bookmark.comment = task.comment;
            bookmark.save();
            EventService.dispatch('BookmarksUpdated');
        }
    },

    startObserving: function HW_startObserving() {
        ObserverService.addObserver(this, HTTP_ON_MODIFY_REQUEST, false);
        ObserverService.addObserver(this, HTTP_ON_EXAMINE_RESPONSE, false);
    },

    stopObserving: function HW_stopObserving() {
        ObserverService.removeObserver(this, HTTP_ON_MODIFY_REQUEST);
        ObserverService.removeObserver(this, HTTP_ON_EXAMINE_RESPONSE);
    },

    observe: function HW_observe(subject, topic, data) {
        if (!(subject instanceof Ci.nsIHttpChannel) ||
            !this._isHBookmarkOperation(subject))
            return;
        switch (topic) {
        case HTTP_ON_MODIFY_REQUEST:
            this.onRequest(subject);
            break;

        case HTTP_ON_EXAMINE_RESPONSE:
            this.onResponse(subject);
            break;
        }
    },

    _isHBookmarkOperation: function HW__isHBookmarkOperation(channel) {
        let uri = channel.URI;
        return /\.hatena\.ne\.jp$/.test(uri.host) &&
               /^\/(?:bookmarklet\.edit|[\w-]+\/add\.edit)\b/.test(uri.path);
    }
};


function printRequestHeaders(channel) {
    let visitor = {
        visitHeader: function visitHeader(header, value) {
            this[header] = value;
        }
    };
    channel.visitRequestHeaders(visitor);
    delete visitor.visitHeader;
    p(channel.URI.spec);
    p.apply(null, [header + ": " + value
                   for ([header, value] in Iterator(visitor))]);
}

function printPostData(channel) {
    if (!(channel instanceof Ci.nsIUploadChannel)) return;
    let rawStream = channel.uploadStream;
    if (!(rawStream instanceof Ci.nsISeekableStream)) return;
    let stream = Cc["@mozilla.org/scriptableinputstream;1"].
                 createInstance(Ci.nsIScriptableInputStream);
    stream.init(rawStream);
    let body = stream.read(stream.available());
    rawStream.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
    p("Post Data:", body);
}


HttpWatcher.startObserving();
window.addEventListener("unload", function () {
    p("stop HTTP observing");
    HttpWatcher.stopObserving();
}, false);
