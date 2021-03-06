/**
 * MIT License
 *
 * Copyright (c) 2017-present, Elasticsearch BV
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

import {
  apmSymbol,
  patchMethod,
  XHR_SYNC,
  XHR_URL,
  XHR_METHOD,
  XHR_IGNORE
} from './patch-utils'

import { scheduleMacroTask } from '../utils'

import {
  SCHEDULE,
  INVOKE,
  CLEAR,
  XMLHTTPREQUEST,
  ADD_EVENT_LISTENER_STR,
  REMOVE_EVENT_LISTENER_STR
} from '../constants'

const XHR_TASK = apmSymbol('xhrTask')
const XHR_LISTENER = apmSymbol('xhrListener')
const XHR_SCHEDULED = apmSymbol('xhrScheduled')

export function patchXMLHttpRequest(callback) {
  const XMLHttpRequestPrototype = XMLHttpRequest.prototype

  let oriAddListener = XMLHttpRequestPrototype[ADD_EVENT_LISTENER_STR]
  let oriRemoveListener = XMLHttpRequestPrototype[REMOVE_EVENT_LISTENER_STR]
  if (!oriAddListener) {
    const XMLHttpRequestEventTarget = window['XMLHttpRequestEventTarget']
    if (XMLHttpRequestEventTarget) {
      const XMLHttpRequestEventTargetPrototype =
        XMLHttpRequestEventTarget.prototype
      oriAddListener =
        XMLHttpRequestEventTargetPrototype[ADD_EVENT_LISTENER_STR]
      oriRemoveListener =
        XMLHttpRequestEventTargetPrototype[REMOVE_EVENT_LISTENER_STR]
    }
  }

  const READY_STATE_CHANGE = 'readystatechange'
  const LOAD = 'load'

  function invokeTask(task) {
    task.state = INVOKE
    callback(INVOKE, task)
  }

  function scheduleTask(task) {
    XMLHttpRequest[XHR_SCHEDULED] = false
    task.state = SCHEDULE
    callback(SCHEDULE, task)

    const { aborted, target } = task.data
    if (!oriAddListener) {
      oriAddListener = target[ADD_EVENT_LISTENER_STR]
      oriRemoveListener = target[REMOVE_EVENT_LISTENER_STR]
    }

    // remove existing event listener
    const listener = target[XHR_LISTENER]
    if (listener) {
      oriRemoveListener.call(target, READY_STATE_CHANGE, listener)
      oriRemoveListener.call(target, LOAD, listener)
    }

    let earlierEvent
    const newListener = (target[XHR_LISTENER] = ({ type }) => {
      /**
       * In certain frameworks (e.g. angular/http) the http request is aborted
       * as soon as it completes, and that causes the state of the XHR to change.
       * See https://github.com/angular/angular/issues/33822 for more.
       */
      if (earlierEvent) {
        if (earlierEvent != type) {
          scheduleMacroTask(() => {
            /**
             * This check is necessary since the readystatechange event can be fired
             * multiple times (e.g. in IE) and since we schedule a macro task
             * to invoke the task, we need to make sure that we don't invoke
             * the task multiple times.
             */
            if (task.state !== INVOKE) {
              invokeTask(task)
            }
          })
        }
      } else {
        if (target.readyState === target.DONE) {
          /**
           * On some browsers XMLHttpRequest will fire onreadystatechange with
           * readyState=4 multiple times, so we need to check task state here
           */
          if (
            !aborted &&
            XMLHttpRequest[XHR_SCHEDULED] &&
            task.state === SCHEDULE
          ) {
            earlierEvent = type
          }
        }
      }
    })
    /**
     * Register event listeners for readystatechange and load events
     */
    oriAddListener.call(target, READY_STATE_CHANGE, newListener)
    oriAddListener.call(target, LOAD, newListener)

    const storedTask = target[XHR_TASK]
    if (!storedTask) {
      target[XHR_TASK] = task
    }
  }

  function clearTask(task) {
    task.state = CLEAR
    callback(CLEAR, task)
    const data = task.data
    // Note - ideally, we would call data.target.removeEventListener here, but it's too late
    // to prevent it from firing. So instead, we store info for the event listener.
    data.aborted = true
  }

  const openNative = patchMethod(
    XMLHttpRequestPrototype,
    'open',
    () =>
      function(self, args) {
        if (!self[XHR_IGNORE]) {
          self[XHR_METHOD] = args[0]
          self[XHR_URL] = args[1]
          self[XHR_SYNC] = args[2] === false
        }
        return openNative.apply(self, args)
      }
  )

  const sendNative = patchMethod(
    XMLHttpRequestPrototype,
    'send',
    () =>
      function(self, args) {
        if (self[XHR_IGNORE]) {
          return sendNative.apply(self, args)
        }

        const task = {
          source: XMLHTTPREQUEST,
          state: '',
          type: 'macroTask',
          data: {
            target: self,
            method: self[XHR_METHOD],
            sync: self[XHR_SYNC],
            url: self[XHR_URL],
            aborted: false
          }
        }
        scheduleTask(task)
        const result = sendNative.apply(self, args)
        XMLHttpRequest[XHR_SCHEDULED] = true
        if (self[XHR_SYNC]) {
          invokeTask(task)
        }
        return result
      }
  )

  const abortNative = patchMethod(
    XMLHttpRequestPrototype,
    'abort',
    () =>
      function(self, args) {
        if (!self[XHR_IGNORE]) {
          const task = self[XHR_TASK]
          if (task && typeof task.type === 'string') {
            // If the XHR has already been aborted, do nothing.
            if (task.data && task.data.aborted) {
              return
            }
            clearTask(task)
          }
        }
        return abortNative.apply(self, args)
      }
  )
}
