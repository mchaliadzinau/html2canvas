import {Bounds, parseBounds, parseDocumentSize} from './css/layout/bounds';
import {color, Color, COLORS, isTransparent} from './css/types/color';
import {Parser} from './css/syntax/parser';
import {CloneOptions, DocumentCloner} from './dom/document-cloner';
import {isBodyElement, isHTMLElement, parseTree} from './dom/node-parser';
import {Logger} from './core/logger';
import {CacheStorage, ResourceOptions} from './core/cache-storage';
import {CanvasRenderer, RenderOptions} from './render/canvas/canvas-renderer';
import {ForeignObjectRenderer} from './render/canvas/foreignobject-renderer';

export type Options = CloneOptions &
    RenderOptions &
    ResourceOptions & {
        backgroundColor: string;
        foreignObjectRendering: boolean;
        logging: boolean;
        removeContainer?: boolean;
    };

export type Setup = {
    ownerDocument: Document, 
    instanceName: string, 
    container: HTMLIFrameElement, 
    options: Options, 
    clonedElement: HTMLElement | undefined
}

const parseColor = (value: string): Color => color.parse(Parser.create(value).parseComponentValue());

const html2canvas = async (element: HTMLElement, options: Partial<Options> = {}): Promise<HTMLCanvasElement> => {
    const setup = await getSetup(element, options);
    return renderElement(element, options, setup).then(canvas => {
        Logger.destroy(setup.instanceName);
        CacheStorage.destroy(setup.instanceName);
        return canvas;
    });
};

export default html2canvas;
export const html2canvases = async (elements: HTMLElement[], options: Partial<Options> = {}): Promise<Number> => {
    let chain: Promise<number> = Promise.resolve(1);
    const setup = await getSetup(elements[0], options);
    if(!setup.options.onrendered) {
        return Promise.reject('options.onrendered must be defined');
    }
    elements.forEach((element, idx) => {
        chain = chain.then(canvasId => {
            let nextSetup = {...setup};
                nextSetup.options = {...setup.options, removeContainer: idx === elements.length - 1}; // remove container only after all elements are processed}
            if(idx>0 && setup.container.contentWindow && setup.container.contentWindow.document) {
                const ownerDocument = element.ownerDocument;
                if (!ownerDocument) {
                    throw new Error(`Element is not attached to a Document`);
                }
                const {width, height, left, top} = isBodyElement(element) || isHTMLElement(element) ? parseDocumentSize(ownerDocument) : parseBounds(element);
                
                nextSetup.clonedElement = getClonedElement(setup.container.contentWindow.document, element);
                Object.assign(nextSetup.options, {
                    x: left,
                    y: top,
                    width: Math.ceil(width),
                    height: Math.ceil(height),
                });
            }
            return renderElement(element, options, nextSetup).then(canvas => {
                if(setup.options.onrendered) {
                    if(setup.options.onrendered(canvas)) {
                        return canvasId+1;
                    } else {
                        return Promise.reject(new Error(`Rendering was cancelled on ${canvasId} element`));
                    }
                } else {
                    return Promise.reject(new Error(`options.onrendered must be defined. Last canvas id was ${canvasId}`));
                }

            })
        });
    });
    return chain.then(count => {
        Logger.destroy(setup.instanceName);
        CacheStorage.destroy(setup.instanceName);
        return count;
    });
};

CacheStorage.setContext(window);

const getSetup = async (element: HTMLElement, opts: Partial<Options>): Promise<Setup> => {
    const ownerDocument = element.ownerDocument;

    if (!ownerDocument) {
        throw new Error(`Element is not attached to a Document`);
    }

    const defaultView = ownerDocument.defaultView;

    if (!defaultView) {
        throw new Error(`Document is not attached to a Window`);
    }

    const instanceName = (Math.round(Math.random() * 1000) + Date.now()).toString(16);

    const {width, height, left, top} =
        isBodyElement(element) || isHTMLElement(element) ? parseDocumentSize(ownerDocument) : parseBounds(element);

    const defaultResourceOptions = {
        allowTaint: false,
        imageTimeout: 15000,
        proxy: undefined,
        useCORS: false
    };

    const resourceOptions: ResourceOptions = {...defaultResourceOptions, ...opts};

    const defaultOptions = {
        backgroundColor: '#ffffff',
        cache: opts.cache ? opts.cache : CacheStorage.create(instanceName, resourceOptions),
        logging: true,
        removeContainer: true,
        foreignObjectRendering: false,
        scale: defaultView.devicePixelRatio || 1,
        windowWidth: defaultView.innerWidth,
        windowHeight: defaultView.innerHeight,
        scrollX: defaultView.pageXOffset,
        scrollY: defaultView.pageYOffset,
        x: left,
        y: top,
        width: Math.ceil(width),
        height: Math.ceil(height),
        id: instanceName
    };

    const options: Options = {...defaultOptions, ...resourceOptions, ...opts};

    const windowBounds = new Bounds(options.scrollX, options.scrollY, options.windowWidth, options.windowHeight);

    Logger.create(instanceName);
    Logger.getInstance(instanceName).debug(`Starting document clone`);
    const documentCloner = new DocumentCloner(element, {
        id: instanceName,
        onclone: options.onclone,
        ignoreElements: options.ignoreElements,
        inlineImages: options.foreignObjectRendering,
        copyStyles: options.foreignObjectRendering
    });
    const clonedElement = documentCloner.clonedReferenceElement;

    const container = await documentCloner.toIFrame(ownerDocument, windowBounds);
    return {ownerDocument, instanceName, container, options, clonedElement};
}

const renderElement = async (element: HTMLElement, opts: Partial<Options>, setup: Setup): Promise<HTMLCanvasElement> => {
    const {ownerDocument, instanceName, container, options, clonedElement} = setup;
    if (!clonedElement) {
        return Promise.reject(`Unable to find element in cloned iframe`);
    }

    // http://www.w3.org/TR/css3-background/#special-backgrounds
    const documentBackgroundColor = ownerDocument.documentElement
        ? parseColor(getComputedStyle(ownerDocument.documentElement).backgroundColor as string)
        : COLORS.TRANSPARENT;
    const bodyBackgroundColor = ownerDocument.body
        ? parseColor(getComputedStyle(ownerDocument.body).backgroundColor as string)
        : COLORS.TRANSPARENT;

    const bgColor = opts.backgroundColor;
    const defaultBackgroundColor = typeof bgColor === 'string' ? parseColor(bgColor) : 0xffffffff;

    const backgroundColor =
        element === ownerDocument.documentElement
            ? isTransparent(documentBackgroundColor)
                ? isTransparent(bodyBackgroundColor)
                    ? defaultBackgroundColor
                    : bodyBackgroundColor
                : documentBackgroundColor
            : defaultBackgroundColor;

    const renderOptions = {
        id: instanceName,
        cache: options.cache,
        backgroundColor,
        scale: options.scale,
        x: options.x,
        y: options.y,
        scrollX: options.scrollX,
        scrollY: options.scrollY,
        width: options.width,
        height: options.height,
        windowWidth: options.windowWidth,
        windowHeight: options.windowHeight
    };

    let canvas;

    if (options.foreignObjectRendering) {
        Logger.getInstance(instanceName).debug(`Document cloned, using foreign object rendering`);
        const renderer = new ForeignObjectRenderer(renderOptions);
        canvas = await renderer.render(clonedElement);
    } else {
        Logger.getInstance(instanceName).debug(`Document cloned, using computed rendering`);

        CacheStorage.attachInstance(options.cache);
        Logger.getInstance(instanceName).debug(`Starting DOM parsing`);
        const root = parseTree(clonedElement);
        CacheStorage.detachInstance();

        if (backgroundColor === root.styles.backgroundColor) {
            root.styles.backgroundColor = COLORS.TRANSPARENT;
        }

        Logger.getInstance(instanceName).debug(`Starting renderer`);

        const renderer = new CanvasRenderer(renderOptions);
        canvas = await renderer.render(root);
    }

    if (options.removeContainer === true) {
        if (!cleanContainer(container)) {
            Logger.getInstance(instanceName).error(`Cannot detach cloned iframe as it is not in the DOM anymore`);
        }
    }

    Logger.getInstance(instanceName).debug(`Finished rendering`);

    return canvas;
};

const cleanContainer = (container: HTMLIFrameElement): boolean => {
    if (container.parentNode) {
        container.parentNode.removeChild(container);
        return true;
    }
    return false;
};

const getClonedElement = (clonedDocument: Document, element: Node) : HTMLElement => {
    if (element && element.nodeType == 1 && element.parentNode) {
        let path = '';
        let parent = (element.parentNode as Node & ParentNode | null) ;
        while (parent && parent.nodeType == 1) {
            const parentTagName = parent.nodeName.toLowerCase();
            const parentClasses = (parent as HTMLElement).className;
            const parentId = (parent as HTMLElement).id;
            
            if (parentTagName === 'html' || parentTagName === 'body') {
                path = parentTagName + ' ' + path;
				break;
            } else {
                let selector;
                if (parentId) {
                    selector = '#' + parentId;
                } else if (parentClasses.length > 0) {
                    selector = parentTagName + '.' + parentClasses.replace(/ /g, '.');
                } else {
                    selector = parentTagName;
                }
                path = ' ' + selector + path;
                parent = parent.parentNode;
			}
        }

        const childIndex = Array.prototype.indexOf.call(element.parentNode.children, element);
        const clonedElementParent = clonedDocument.querySelector(path);
        if(clonedElementParent) {
            return (clonedElementParent.children[childIndex] as HTMLElement);
        } else {
            throw new Error('unable to find element in a cloned document');
        }
    } else {
        throw new Error('provided argument is not HTMLElement or has no parent');
    }
}