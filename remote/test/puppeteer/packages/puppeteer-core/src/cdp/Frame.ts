/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {Protocol} from 'devtools-protocol';

import type {CDPSession} from '../api/CDPSession.js';
import {Frame, FrameEvent, throwIfDetached} from '../api/Frame.js';
import type {HTTPResponse} from '../api/HTTPResponse.js';
import type {WaitTimeoutOptions} from '../api/Page.js';
import {UnsupportedOperation} from '../common/Errors.js';
import {setPageContent} from '../common/util.js';
import {Deferred} from '../util/Deferred.js';
import {disposeSymbol} from '../util/disposable.js';
import {isErrorLike} from '../util/ErrorLike.js';

import type {
  DeviceRequestPrompt,
  DeviceRequestPromptManager,
} from './DeviceRequestPrompt.js';
import type {FrameManager} from './FrameManager.js';
import {IsolatedWorld} from './IsolatedWorld.js';
import {MAIN_WORLD, PUPPETEER_WORLD} from './IsolatedWorlds.js';
import {
  LifecycleWatcher,
  type PuppeteerLifeCycleEvent,
} from './LifecycleWatcher.js';
import type {CdpPage} from './Page.js';

/**
 * @internal
 */
export class CdpFrame extends Frame {
  #url = '';
  #detached = false;
  #client!: CDPSession;

  _frameManager: FrameManager;
  override _id: string;
  _loaderId = '';
  _lifecycleEvents = new Set<string>();
  override _parentId?: string;

  constructor(
    frameManager: FrameManager,
    frameId: string,
    parentFrameId: string | undefined,
    client: CDPSession
  ) {
    super();
    this._frameManager = frameManager;
    this.#url = '';
    this._id = frameId;
    this._parentId = parentFrameId;
    this.#detached = false;

    this._loaderId = '';

    this.updateClient(client);

    this.on(FrameEvent.FrameSwappedByActivation, () => {
      // Emulate loading process for swapped frames.
      this._onLoadingStarted();
      this._onLoadingStopped();
    });
  }

  /**
   * This is used internally in DevTools.
   *
   * @internal
   */
  _client(): CDPSession {
    return this.#client;
  }

  /**
   * Updates the frame ID with the new ID. This happens when the main frame is
   * replaced by a different frame.
   */
  updateId(id: string): void {
    this._id = id;
  }

  updateClient(client: CDPSession, keepWorlds = false): void {
    this.#client = client;
    if (!keepWorlds) {
      this.worlds = {
        [MAIN_WORLD]: new IsolatedWorld(
          this,
          this._frameManager.timeoutSettings
        ),
        [PUPPETEER_WORLD]: new IsolatedWorld(
          this,
          this._frameManager.timeoutSettings
        ),
      };
    } else {
      this.worlds[MAIN_WORLD].frameUpdated();
      this.worlds[PUPPETEER_WORLD].frameUpdated();
    }
  }

  override page(): CdpPage {
    return this._frameManager.page();
  }

  override isOOPFrame(): boolean {
    return this.#client !== this._frameManager.client;
  }

  @throwIfDetached
  override async goto(
    url: string,
    options: {
      referer?: string;
      referrerPolicy?: string;
      timeout?: number;
      waitUntil?: PuppeteerLifeCycleEvent | PuppeteerLifeCycleEvent[];
    } = {}
  ): Promise<HTTPResponse | null> {
    const {
      referer = this._frameManager.networkManager.extraHTTPHeaders()['referer'],
      referrerPolicy = this._frameManager.networkManager.extraHTTPHeaders()[
        'referer-policy'
      ],
      waitUntil = ['load'],
      timeout = this._frameManager.timeoutSettings.navigationTimeout(),
    } = options;

    let ensureNewDocumentNavigation = false;
    const watcher = new LifecycleWatcher(
      this._frameManager.networkManager,
      this,
      waitUntil,
      timeout
    );
    let error = await Deferred.race([
      navigate(
        this.#client,
        url,
        referer,
        referrerPolicy as Protocol.Page.ReferrerPolicy,
        this._id
      ),
      watcher.terminationPromise(),
    ]);
    if (!error) {
      error = await Deferred.race([
        watcher.terminationPromise(),
        ensureNewDocumentNavigation
          ? watcher.newDocumentNavigationPromise()
          : watcher.sameDocumentNavigationPromise(),
      ]);
    }

    try {
      if (error) {
        throw error;
      }
      return await watcher.navigationResponse();
    } finally {
      watcher.dispose();
    }

    async function navigate(
      client: CDPSession,
      url: string,
      referrer: string | undefined,
      referrerPolicy: Protocol.Page.ReferrerPolicy | undefined,
      frameId: string
    ): Promise<Error | null> {
      try {
        const response = await client.send('Page.navigate', {
          url,
          referrer,
          frameId,
          referrerPolicy,
        });
        ensureNewDocumentNavigation = !!response.loaderId;
        if (response.errorText === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE') {
          return null;
        }
        return response.errorText
          ? new Error(`${response.errorText} at ${url}`)
          : null;
      } catch (error) {
        if (isErrorLike(error)) {
          return error;
        }
        throw error;
      }
    }
  }

  @throwIfDetached
  override async waitForNavigation(
    options: {
      timeout?: number;
      waitUntil?: PuppeteerLifeCycleEvent | PuppeteerLifeCycleEvent[];
    } = {}
  ): Promise<HTTPResponse | null> {
    const {
      waitUntil = ['load'],
      timeout = this._frameManager.timeoutSettings.navigationTimeout(),
    } = options;
    const watcher = new LifecycleWatcher(
      this._frameManager.networkManager,
      this,
      waitUntil,
      timeout
    );
    const error = await Deferred.race([
      watcher.terminationPromise(),
      watcher.sameDocumentNavigationPromise(),
      watcher.newDocumentNavigationPromise(),
    ]);
    try {
      if (error) {
        throw error;
      }
      return await watcher.navigationResponse();
    } finally {
      watcher.dispose();
    }
  }

  override get client(): CDPSession {
    return this.#client;
  }

  override mainRealm(): IsolatedWorld {
    return this.worlds[MAIN_WORLD];
  }

  override isolatedRealm(): IsolatedWorld {
    return this.worlds[PUPPETEER_WORLD];
  }

  @throwIfDetached
  override async setContent(
    html: string,
    options: {
      timeout?: number;
      waitUntil?: PuppeteerLifeCycleEvent | PuppeteerLifeCycleEvent[];
    } = {}
  ): Promise<void> {
    const {
      waitUntil = ['load'],
      timeout = this._frameManager.timeoutSettings.navigationTimeout(),
    } = options;

    await setPageContent(this.isolatedRealm(), html);

    const watcher = new LifecycleWatcher(
      this._frameManager.networkManager,
      this,
      waitUntil,
      timeout
    );
    const error = await Deferred.race<void | Error | undefined>([
      watcher.terminationPromise(),
      watcher.lifecyclePromise(),
    ]);
    watcher.dispose();
    if (error) {
      throw error;
    }
  }

  override url(): string {
    return this.#url;
  }

  override parentFrame(): CdpFrame | null {
    return this._frameManager._frameTree.parentFrame(this._id) || null;
  }

  override childFrames(): CdpFrame[] {
    return this._frameManager._frameTree.childFrames(this._id);
  }

  #deviceRequestPromptManager(): DeviceRequestPromptManager {
    const rootFrame = this.page().mainFrame();
    if (this.isOOPFrame() || rootFrame === null) {
      return this._frameManager._deviceRequestPromptManager(this.#client);
    } else {
      return rootFrame._frameManager._deviceRequestPromptManager(this.#client);
    }
  }

  @throwIfDetached
  override async waitForDevicePrompt(
    options: WaitTimeoutOptions = {}
  ): Promise<DeviceRequestPrompt> {
    return await this.#deviceRequestPromptManager().waitForDevicePrompt(
      options
    );
  }

  _navigated(framePayload: Protocol.Page.Frame): void {
    this._name = framePayload.name;
    this.#url = `${framePayload.url}${framePayload.urlFragment || ''}`;
  }

  _navigatedWithinDocument(url: string): void {
    this.#url = url;
  }

  _onLifecycleEvent(loaderId: string, name: string): void {
    if (name === 'init') {
      this._loaderId = loaderId;
      this._lifecycleEvents.clear();
    }
    this._lifecycleEvents.add(name);
  }

  _onLoadingStopped(): void {
    this._lifecycleEvents.add('DOMContentLoaded');
    this._lifecycleEvents.add('load');
  }

  _onLoadingStarted(): void {
    this._hasStartedLoading = true;
  }

  override get detached(): boolean {
    return this.#detached;
  }

  [disposeSymbol](): void {
    if (this.#detached) {
      return;
    }
    this.#detached = true;
    this.worlds[MAIN_WORLD][disposeSymbol]();
    this.worlds[PUPPETEER_WORLD][disposeSymbol]();
  }

  exposeFunction(): never {
    throw new UnsupportedOperation();
  }
}
