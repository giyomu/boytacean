import { ButtonSwitch, Emulator, Info, Pair, PanelTab } from "emukit";
import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GameboyEmulator, SerialDevice, bufferToDataUrl } from "../../../ts";

import "./serial-section.css";

const DEVICE_ICON: { [key: string]: string } = {
    null: "🛑",
    logger: "📜",
    printer: "🖨️"
};

const sendAskToBridge = async (
    message: string,
    prompt: string,
    emulator: GameboyEmulator,
    appendLoggerLine: (line: string) => void
) => {
    try {
        const response = await fetch("http://localhost:3000/api/gb-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, prompt }),
        });
        const data = (await response.json()) as {
            reply?: string;
            aiReply?: string;
            receivedPrompt?: string;
        };
        console.log("[Boytacean bridge] server JSON:", data);

        const replyText = String(data.reply ?? "WAIT");
        appendLoggerLine(`NODE -> FRONTEND: ${replyText}`);

        const framedReply = replyText.endsWith("\n")
            ? replyText
            : replyText + "\n";
        console.log(
            "[Boytacean bridge] framed reply text:",
            JSON.stringify(framedReply)
        );

        emulator.clearSerialQueue?.();

        for (let index = 0; index < framedReply.length; index++) {
            const byte = framedReply.charCodeAt(index);
            const char = framedReply[index];
            console.log("[Boytacean bridge] queue byte:", {
                index,
                byte,
                hex: `0x${byte.toString(16).padStart(2, "0")}`,
                char: char === "\n" ? "\\n" : char,
            });
            emulator.queueSerialByte(byte);
        }

        console.log("[Boytacean bridge] queued reply complete:", replyText);
        appendLoggerLine(`QUEUED TO GB: ${replyText}`);
    } catch (error) {
        console.error("[Boytacean bridge] server request failed:", error);
    }
};

type SerialSectionProps = {
    emulator: GameboyEmulator;
    style?: string[];
};

export const SerialSection: FC<SerialSectionProps> = ({
    emulator,
    style = []
}) => {
    const classes = useMemo(
        () => ["serial-section", ...style].join(" "),
        [style]
    );
    const [loggerData, setLoggerData] = useState<string>();
    const [printerImageUrls, setPrinterImageUrls] = useState<string[]>();
    const loggerDataRef = useRef<string[]>([]);
    const messageBufferRef = useRef("");
    const printerDataRef = useRef<string[]>([]);
    const loggerRef = useRef<HTMLDivElement>(null);
    const imagesRef = useRef<HTMLDivElement>(null);

    const appendLoggerLine = useCallback((line: string) => {
        loggerDataRef.current.push(`\n${line}`);
        setLoggerData(loggerDataRef.current.join(""));
    }, []);

    useEffect(() => {
        const onLoggerData = (data: Uint8Array) => {
            const byte = data[0];
            const charByte = String.fromCharCode(byte);
            console.log("[Boytacean serial]", {
                byte,
                hex: `0x${byte.toString(16).padStart(2, "0")}`,
                char: charByte,
            });
            if (byte === 0x00) {
                console.log("[Boytacean serial] ignoring null byte");
            } else if (byte !== 0x0d) {
                if (byte === 0x0a) {
                    const message = messageBufferRef.current;
                    messageBufferRef.current = "";
                    if (message !== "") {
                        console.log("[Boytacean serial message]", message);
                        appendLoggerLine(`GB -> BRIDGE: ${message}`);
                        if (message.startsWith("ASK:")) {
                            const prompt = message.slice(4);
                            console.log("[Boytacean bridge] prompt:", prompt);
                            void sendAskToBridge(
                                message,
                                prompt,
                                emulator,
                                appendLoggerLine
                            );
                        }
                    }
                } else {
                    messageBufferRef.current += charByte;
                }
            }
            loggerDataRef.current.push(charByte);
            setLoggerData(loggerDataRef.current.join(""));
        };
        const onPrinterData = (imageBuffer: Uint8Array) => {
            const imageUrl = bufferToDataUrl(imageBuffer, 160);
            printerDataRef.current.unshift(imageUrl);
            setPrinterImageUrls([...printerDataRef.current]);
        };

        const onLogger = (emulator: Emulator, _params: unknown = {}) => {
            const params = _params as Record<string, unknown>;
            onLoggerData(params.data as Uint8Array);
        };
        const onPrinter = (emulator: Emulator, _params: unknown = {}) => {
            const params = _params as Record<string, unknown>;
            onPrinterData(params.imageBuffer as Uint8Array);
        };
        const onRamDebug = (emulator: Emulator, _params: unknown = {}) => {
            const params = _params as Record<string, unknown>;
            appendLoggerLine(String(params.message ?? ""));
        };

        emulator.bind("logger", onLogger);
        emulator.bind("printer", onPrinter);
        emulator.bind("ram-debug", onRamDebug);

        return () => {
            emulator.unbind("logger", onLogger);
            emulator.unbind("printer", onPrinter);
            emulator.unbind("ram-debug", onRamDebug);
        };
    }, [emulator, appendLoggerLine]);

    const onDeviceChange = (option: string) => {
        emulator.loadSerialDevice(option as SerialDevice);
        const optionIcon = DEVICE_ICON[option] ?? "";
        emulator.handlers.showToast?.(
            `${optionIcon} ${option} attached to the serial port & active`
        );
    };

    const getTabs = () => {
        return [
            <Info>
                <Pair
                    key="button-device"
                    name={"Device"}
                    valueNode={
                        <ButtonSwitch
                            options={["null", "logger", "printer"]}
                            value={emulator.serialDevice}
                            uppercase={true}
                            size={"large"}
                            style={["simple"]}
                            onChange={onDeviceChange}
                        />
                    }
                />
                <Pair key="baud-rate" name={"Baud Rate"} value={"1 KB/s"} />
                <Pair
                    key="poll-ai-reply-debug"
                    name={"Debug"}
                    valueNode={
                        <>
                            <button
                                type="button"
                                className="serial-section-poll-ai-reply"
                                onClick={() => {
                                    emulator.pushCStringToReplyVars(0xc640, 12);
                                }}
                            >
                                Push C640 To Reply Vars
                            </button>
                            <button
                                type="button"
                                className="serial-section-poll-ai-reply"
                                onClick={() => {
                                    emulator.debugReadCString(
                                        0xc600,
                                        64,
                                        "packet"
                                    );
                                    emulator.debugReadCString(
                                        0xc640,
                                        128,
                                        "sentence"
                                    );
                                }}
                            >
                                Debug AI Buffer
                            </button>
                            <button
                                type="button"
                                className="serial-section-poll-ai-reply"
                                onClick={() => {
                                    emulator.clearC640SentenceBuffer();
                                }}
                            >
                                Clear C640 Sentence
                            </button>
                        </>
                    }
                />
            </Info>,
            <div className="logger" ref={loggerRef}>
                <div className="logger-data">
                    {loggerData || "Logger contents are empty."}
                </div>
            </div>,
            <div className="printer" ref={imagesRef}>
                <div className="printer-lines">
                    {printerImageUrls ? (
                        printerImageUrls.map((url, index) => (
                            <img
                                key={index}
                                className="printer-line"
                                src={url}
                            />
                        ))
                    ) : (
                        <span className="placeholder">
                            Printer contents are empty.
                        </span>
                    )}
                </div>
            </div>
        ];
    };
    const getTabNames = () => {
        return ["Settings", "Logger", "Printer"];
    };
    return (
        <div className={classes}>
            <PanelTab
                tabs={getTabs()}
                tabNames={getTabNames()}
                selectors={true}
            />
        </div>
    );
};

export default SerialSection;
