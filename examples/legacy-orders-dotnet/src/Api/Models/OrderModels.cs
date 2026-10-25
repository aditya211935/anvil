using System;
using System.Collections.Generic;

namespace Acme.Orders.Api.Models
{
    public enum OrderStatus
    {
        Pending,
        Shipped,
        Cancelled
    }

    public class OrderDto
    {
        public int Id { get; set; }
        public Guid CustomerId { get; set; }
        public OrderStatus Status { get; set; }
        public decimal Total { get; set; }
        public DateTimeOffset PlacedAt { get; set; }
        public List<OrderLineDto> Lines { get; set; } = new();
    }

    public class OrderLineDto
    {
        public string Sku { get; set; } = string.Empty;
        public int Quantity { get; set; }
    }

    public record CreateOrderRequest(Guid CustomerId, List<OrderLineDto> Lines);

    public record CancelOrderRequest(string Reason);

    public interface IOrderRepository
    {
        System.Threading.Tasks.Task<IEnumerable<OrderDto>> ListAsync(OrderStatus? status, int page);
        System.Threading.Tasks.Task<OrderDto> GetAsync(int id);
        System.Threading.Tasks.Task<OrderDto> CreateAsync(CreateOrderRequest request);
        System.Threading.Tasks.Task CancelAsync(int id, string reason);
        System.Threading.Tasks.Task DeleteAsync(int id);
    }
}
