import { ButtonSwitch, Emulator, Info, Pair, PanelTab } from "emukit";
import React, { FC, useEffect, useMemo, useRef, useState } from "react";

import { GameboyEmulator, SerialDevice, bufferToDataUrl } from "../../../ts";

import "./serial-section.css";

const DEVICE_ICON: { [key: string]: string } = {
    null: "🛑",
    logger: "📜",
    printer: "🖨️"
};

const gbReplyQueue: number[] = [];

function queueReplyForGameBoy(reply: string) {
    for (const char of reply) {
        gbReplyQueue.push(char.charCodeAt(0));
    }

    console.log("[Boytacean bridge] queued reply for GB:", {
        reply,
        bytes: [...gbReplyQueue],
    });
}

const sendAskToBridge = async (
    message: string,
    prompt: string,
    emulator: Emulator
) => {
    try {
        const response = await fetch("http://localhost:3000/api/gb-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, prompt }),
        });
        const data = (await response.json()) as { reply?: string };
        console.log("[Boytacean bridge] server reply:", data.reply);
        queueReplyForGameBoy(data.reply ?? "");
        while (gbReplyQueue.length > 0) {
            const queuedReplyByte = gbReplyQueue.shift()!;
            emulator.queueSerialByte(queuedReplyByte);
            console.log("[Boytacean bridge] queued byte into WASM serial input:", {
                byte: queuedReplyByte,
                hex: `0x${queuedReplyByte.toString(16).padStart(2, "0")}`,
                char: String.fromCharCode(queuedReplyByte),
                remaining: gbReplyQueue.length,
            });
        }
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
                        if (message.startsWith("ASK:")) {
                            const prompt = message.slice(4);
                            console.log("[Boytacean bridge] prompt:", prompt);
                            void sendAskToBridge(message, prompt, emulator);
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

        emulator.bind("logger", onLogger);
        emulator.bind("printer", onPrinter);

        return () => {
            emulator.unbind("logger", onLogger);
            emulator.unbind("printer", onPrinter);
        };
    }, [emulator]);

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
