"""Channel manager for coordinating chat channels."""

from __future__ import annotations

import asyncio
from typing import Any, TYPE_CHECKING

from loguru import logger

from nanobot.bus.events import OutboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.channels.base import BaseChannel
from nanobot.config.schema import Config

if TYPE_CHECKING:
    from nanobot.session.manager import SessionManager


class ChannelManager:
    """
    Manages chat channels and coordinates message routing.
    
    Responsibilities:
    - Initialize enabled channels (Telegram, WhatsApp, etc.)
    - Start/stop channels
    - Route outbound messages
    """
    
    def __init__(self, config: Config, bus: MessageBus, session_manager: "SessionManager | None" = None):
        self.config = config
        self.bus = bus
        self.session_manager = session_manager
        self.channels: dict[str, BaseChannel] = {}
        self._dispatch_task: asyncio.Task | None = None
        
        self._init_channels()
    
    # Channel registry: (config_attr, module_path, class_name, extra_kwargs_builder)
    _CHANNEL_DEFS: list[tuple[str, str, str, str | None]] = [
        ("telegram",  "nanobot.channels.telegram",  "TelegramChannel",  "_telegram_kwargs"),
        ("whatsapp",  "nanobot.channels.whatsapp",   "WhatsAppChannel",  None),
        ("discord",   "nanobot.channels.discord",    "DiscordChannel",   None),
        ("feishu",    "nanobot.channels.feishu",     "FeishuChannel",    None),
        ("mochat",    "nanobot.channels.mochat",     "MochatChannel",    None),
        ("dingtalk",  "nanobot.channels.dingtalk",   "DingTalkChannel",  None),
        ("email",     "nanobot.channels.email",      "EmailChannel",     None),
        ("slack",     "nanobot.channels.slack",      "SlackChannel",     None),
        ("qq",        "nanobot.channels.qq",         "QQChannel",        None),
    ]

    def _telegram_kwargs(self) -> dict[str, Any]:
        """Extra kwargs for TelegramChannel (needs groq key + session_manager)."""
        return {
            "groq_api_key": self.config.providers.groq.api_key,
            "session_manager": self.session_manager,
        }

    def _init_channels(self) -> None:
        """Initialize channels based on config."""
        import importlib

        for cfg_attr, module_path, class_name, extras_method in self._CHANNEL_DEFS:
            cfg = getattr(self.config.channels, cfg_attr, None)
            if not cfg or not cfg.enabled:
                continue
            try:
                mod = importlib.import_module(module_path)
                cls = getattr(mod, class_name)
                kwargs: dict[str, Any] = {}
                if extras_method:
                    kwargs = getattr(self, extras_method)()
                self.channels[cfg_attr] = cls(cfg, self.bus, **kwargs)
                logger.info(f"{class_name} channel enabled")
            except ImportError as e:
                logger.warning(f"{class_name} channel not available: {e}")
    
    async def _start_channel(self, name: str, channel: BaseChannel) -> None:
        """Start a channel and log any exceptions."""
        try:
            await channel.start()
        except Exception as e:
            logger.error(f"Failed to start channel {name}: {e}")

    async def start_all(self) -> None:
        """Start all channels and the outbound dispatcher."""
        if not self.channels:
            logger.warning("No channels enabled")
            return
        
        # Start outbound dispatcher
        self._dispatch_task = asyncio.create_task(self._dispatch_outbound())
        
        # Start channels
        tasks = []
        for name, channel in self.channels.items():
            logger.info(f"Starting {name} channel...")
            tasks.append(asyncio.create_task(self._start_channel(name, channel)))
        
        # Wait for all to complete (they should run forever)
        await asyncio.gather(*tasks, return_exceptions=True)
    
    async def stop_all(self) -> None:
        """Stop all channels and the dispatcher."""
        logger.info("Stopping all channels...")
        
        # Stop dispatcher
        if self._dispatch_task:
            self._dispatch_task.cancel()
            try:
                await self._dispatch_task
            except asyncio.CancelledError:
                pass
        
        # Stop all channels
        for name, channel in self.channels.items():
            try:
                await channel.stop()
                logger.info(f"Stopped {name} channel")
            except Exception as e:
                logger.error(f"Error stopping {name}: {e}")
    
    async def _dispatch_outbound(self) -> None:
        """Dispatch outbound messages to the appropriate channel."""
        logger.info("Outbound dispatcher started")
        
        while True:
            try:
                msg = await asyncio.wait_for(
                    self.bus.consume_outbound(),
                    timeout=1.0
                )
                
                channel = self.channels.get(msg.channel)
                if channel:
                    try:
                        await channel.send(msg)
                    except Exception as e:
                        logger.error(f"Error sending to {msg.channel}: {e}")
                else:
                    logger.warning(f"Unknown channel: {msg.channel}")
                    
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
    
    def get_channel(self, name: str) -> BaseChannel | None:
        """Get a channel by name."""
        return self.channels.get(name)
    
    def get_status(self) -> dict[str, Any]:
        """Get status of all channels."""
        return {
            name: {
                "enabled": True,
                "running": channel.is_running
            }
            for name, channel in self.channels.items()
        }
    
    @property
    def enabled_channels(self) -> list[str]:
        """Get list of enabled channel names."""
        return list(self.channels.keys())
